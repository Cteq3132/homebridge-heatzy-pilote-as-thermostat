"use strict";

const url = require("url");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const lan = require("./lan");

// From Heatzy API : https://drive.google.com/drive/folders/0B9nVzuTl4YMOaXAzRnRhdXVma1k
// https://heatzy.com/blog/tout-sur-heatzy
const heatzyUrl = "https://euapi.gizwits.com/app/";
const loginUrl = url.parse(heatzyUrl + "login");
const heatzy_Application_Id = "c70a66ff039d41b4a220e198b0fcc8b3";
const requestTimeout = 10000; // ms, without it a request to Heatzy servers can hang forever
const confirmDelay = 10000; // ms, time for Heatzy servers to reflect a change made from HomeKit
const localConfirmDelay = 1000; // ms, a change made on the local network is reflected at once
const localInfoRetryDelay = 10 * 60 * 1000; // ms, between two attempts to get the passcode from Heatzy servers
const discoveryRetryDelay = 5 * 60 * 1000; // ms, between two searches of the device on the local network

let Service, Characteristic, storagePath;

module.exports = (homebridge) => {
  /* this is the starting point for the plugin where we register the accessory */
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  storagePath = path.join(homebridge.user.storagePath(), "heatzy-pilote");
  homebridge.registerAccessory(
    "homebridge-heatzy-as-Thermostat",
    "HeatzyPilote",
    ThermostatAccessory
  );
};

function ThermostatAccessory(log, config) {
  this.log = log;
  this.config = config;

  // Config
  this.getUrl = url.parse(heatzyUrl + "devdata/" + config["did"] + "/latest");
  this.postUrl = url.parse(heatzyUrl + "control/" + config["did"]);
  this.name = config["name"];
  this.username = config["username"];
  this.password = config["password"];
  this.interval = config["interval"] || 60;
  this.fake_temp = config["fake_temp"] >= 10 && config["fake_temp"] <= 38 ? config["fake_temp"] : 20;
  this.temp_unit = config["temp_unit"] === "F" ? 1 : 0;
  this.trace = config["trace"] || false;
  this.did = config["did"];
  this.local = config["local"] !== false;
  this.configIp = config["ip"] || null;

  // Local mode: passcode, IP and datapoint schema are kept in Homebridge storage,
  // so that Heatzy servers are only needed once
  this.localState = this.local ? loadLocalState(this) : {};
  this.localInfoRetryAt = 0;
  this.discoveryRetryAt = 0;
  this.localQueue = Promise.resolve();
  this.localWorking = null;
  this.lastWriteLocal = false;

  // Heatzy token
  this.heatzyToken = "";
  this.heatzyTokenExpire_at = Date.now() - 10000; // Initial value is 10s in the past, to force login and refresh of token

  this.current_state = null;
  this.target_state = null;
  this.reachable = false;
  this.refreshing = null;
  this.ignoreUpdatesUntil = 0;
  this.confirmTimer = null;

  this.informationService = new Service.AccessoryInformation()
    .setCharacteristic(Characteristic.Manufacturer, "Heatzy")
    .setCharacteristic(Characteristic.Model, "Heatzy Pilote V2")
    .setCharacteristic(Characteristic.SerialNumber, "unknown");
  this.service = new Service.Thermostat(this.config.name);

  this.service
    .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .on("get", this.handleCurrentHeatingCoolingStateGet.bind(this));

  this.service
    .getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .on("get", this.handleTargetHeatingCoolingStateGet.bind(this))
    .on("set", this.handleTargetHeatingCoolingStateSet.bind(this));

  this.service
    .getCharacteristic(Characteristic.CurrentTemperature)
    .on("get", this.handleCurrentTemperatureGet.bind(this));

  this.service
    .getCharacteristic(Characteristic.TargetTemperature)
    .on("get", this.handleTargetTemperatureGet.bind(this))
    .on("set", this.handleTargetTemperatureSet.bind(this));

  this.service
    .getCharacteristic(Characteristic.TemperatureDisplayUnits)
    .on("get", this.handleTemperatureDisplayUnitsGet.bind(this))
    .on("set", this.handleTemperatureDisplayUnitsSet.bind(this));

  this.updateState(); // Get the current state of the device, and update HomeKit
  setInterval(this.updateState.bind(this), this.interval * 1000); // The state of the device will be checked every this.interval seconds
  this.log("starting HeatzyPilote...");
}

async function updateToken(device) {
  try {
    const response = await axios({
      method: "post",
      url: loginUrl,
      timeout: requestTimeout,
      headers: {
        "X-Gizwits-Application-Id": heatzy_Application_Id,
      },
      data: {
        username: device.username,
        password: device.password,
        lang: "en",
      },
    });
    if (response.status == 200) {
      device.heatzyToken = response.data.token;
      device.heatzyTokenExpire_at = response.data.expire_at * 1000;
    } else {
      device.log(
        `${response.status} ${response.statusText} ${response.data.error_message}`
      );
    }
  } catch (error) {
    // Never throw from here: an exception would become an unhandled rejection and crash Homebridge
    device.log("Error : " + describeError(error));
    device.log("Error - Plugin unable to login to Heatzy server");
  }
}

async function ensureToken(device) {
  if (device.heatzyTokenExpire_at < Date.now()) {
    await updateToken(device);
  }
}

// Network errors (timeout, DNS, connection reset...) have no response
function describeError(error) {
  if (error && error.response) {
    return error.response.status + " " + error.response.statusText;
  }
  return error && error.message ? error.message : String(error);
}

// CurrentHeatingCoolingState and TargetHeatingCoolingState share the values OFF (0), HEAT (1) and COOL (2)
function modeToState(device, mode) {
  switch (mode) {
    case "cft":
      return Characteristic.CurrentHeatingCoolingState.HEAT;
    case "eco":
      return Characteristic.CurrentHeatingCoolingState.COOL;
    case "stop":
    case "fro":
      return Characteristic.CurrentHeatingCoolingState.OFF;
    default:
      if (device.trace) {
        device.log("Unknown mode " + mode + ", displayed as Off");
      }
      return Characteristic.CurrentHeatingCoolingState.OFF;
  }
}

function stateFromAttrs(device, mode, timer_switch) {
  const current = modeToState(device, mode);
  const target = timer_switch == 1
    ? Characteristic.TargetHeatingCoolingState.AUTO
    : current;
  return { current, target };
}

function localStateFile(device) {
  return path.join(storagePath, device.did + ".json");
}

function loadLocalState(device) {
  try {
    return JSON.parse(fs.readFileSync(localStateFile(device), "utf8"));
  } catch (error) {
    return {};
  }
}

function saveLocalState(device) {
  try {
    fs.mkdirSync(storagePath, { recursive: true });
    // The passcode gives control of the device on the local network
    fs.writeFileSync(localStateFile(device), JSON.stringify(device.localState), { mode: 0o600 });
  } catch (error) {
    device.log("Error - Cannot save local mode state: " + describeError(error));
  }
}

async function cloudGet(device, endpoint) {
  await ensureToken(device);
  const response = await axios.get(heatzyUrl + endpoint, {
    timeout: requestTimeout,
    headers: {
      "X-Gizwits-Application-Id": heatzy_Application_Id,
      "X-Gizwits-User-token": device.heatzyToken,
    },
  });
  return response.data;
}

// Gets the passcode and the datapoint schema from Heatzy servers, if they are not known yet.
// Returns true when the device can be controlled locally
async function ensureLocalInfo(device) {
  const state = device.localState;
  if (state.unsupported) return false;
  if (state.passcode && state.schema) return true;
  if (Date.now() < device.localInfoRetryAt) return false;
  device.localInfoRetryAt = Date.now() + localInfoRetryDelay;

  try {
    let binding = null;
    for (let skip = 0; !binding; skip += 20) {
      const devices = (await cloudGet(device, "bindings?limit=20&skip=" + skip)).devices || [];
      binding = devices.find((d) => d.did === device.did);
      if (devices.length < 20) break;
    }
    if (!binding || !binding.passcode) {
      device.log("Error - Local mode: no passcode for this device on Heatzy servers");
      return false;
    }
    const schema = lan.compactSchema(await cloudGet(device, "datapoint?product_key=" + binding.product_key));
    if (!schema) {
      device.log("Local mode is not supported by this device (" + binding.product_name + "), using Heatzy servers");
      device.localState = { unsupported: true };
      saveLocalState(device);
      return false;
    }
    device.localState = Object.assign({}, state, {
      passcode: binding.passcode,
      mac: binding.mac,
      ip: binding.lan_ip || state.ip || null,
      schema,
    });
    saveLocalState(device);
    if (device.trace) {
      device.log("Local mode: passcode and schema saved for " + binding.product_name);
    }
    return true;
  } catch (error) {
    device.log("Error - Local mode: cannot get the passcode from Heatzy servers: " + describeError(error));
    return false;
  }
}

async function findLocalIp(device, force) {
  if (device.configIp) return device.configIp;
  if (device.localState.ip && !force) return device.localState.ip;
  if (Date.now() < device.discoveryRetryAt) return null;

  const ip = await lan.discover(device.did, [device.localState.ip]);
  if (!ip) {
    device.discoveryRetryAt = Date.now() + discoveryRetryDelay;
    return null;
  }
  if (ip !== device.localState.ip) {
    device.log("Local mode: device found at " + ip);
    device.localState.ip = ip;
    saveLocalState(device);
  }
  return ip;
}

// Runs fn(session) in an authenticated LAN session. Sessions of a device never overlap.
// Returns the result of fn, or throws
function withLocalSession(device, fn) {
  const run = async () => {
    if (!(await ensureLocalInfo(device))) throw new Error("local mode unavailable");

    let ip = await findLocalIp(device, false);
    for (let attempt = 0; ; attempt++) {
      if (!ip) throw new Error("device not found on the local network");
      const session = new lan.Session(ip, device.did);
      try {
        await session.open(device.localState.passcode);
        return await fn(session);
      } catch (error) {
        if (error.code === "PASSCODE") {
          // The device has been reset or bound again: get the new passcode
          device.localState.passcode = null;
          device.localInfoRetryAt = 0;
          saveLocalState(device);
          throw error;
        }
        const connectionError = ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "EHOSTDOWN", "ENETUNREACH"].includes(error.code) ||
          /timeout/i.test(error.message);
        if (attempt > 0 || !connectionError) throw error;
        // The IP may have changed (DHCP): search the device again
        if (!device.configIp) {
          ip = (await findLocalIp(device, true)) || ip;
        }
        // The device drops logins that arrive at the same time (e.g. from the Heatzy app): retry once, a bit later
        await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 700));
      } finally {
        session.close();
      }
    }
  };
  const result = device.localQueue.then(run);
  device.localQueue = result.catch(() => {});
  return result;
}

// Logs only the changes between local and cloud, not every failed attempt
function setLocalWorking(device, working, error) {
  if (working === device.localWorking) return;
  if (working) {
    device.log("Local mode: connected to the device on the local network");
  } else if (device.localState.passcode || device.trace) {
    device.log("Local mode unavailable (" + describeError(error) + "), using Heatzy servers");
  }
  device.localWorking = working;
}

async function getLocalDeviceState(device) {
  return withLocalSession(device, async (session) => {
    const status = await session.read();
    const attrs = device.localState.schema.attrs;
    return stateFromAttrs(device, lan.decodeAttr(status, attrs.mode), lan.decodeAttr(status, attrs.timer_switch));
  });
}

async function setLocalTargetState(device, state) {
  const attrs = { timer_switch: state === 3 ? 1 : 0 };
  if (state !== 3) {
    attrs.mode = (state === 0) ? "stop" : (state === 1 ? "cft" : "eco");
  }
  await withLocalSession(device, async (session) => {
    const status = await session.read();
    await session.write(device.localState.schema, status, attrs);
  });
  return state;
}

// Returns { current, target }, or null if the state could not be read
async function getDeviceState(device) {
  if (device.local) {
    try {
      const state = await getLocalDeviceState(device);
      setLocalWorking(device, true);
      return state;
    } catch (error) {
      setLocalWorking(device, false, error);
    }
  }
  return getCloudDeviceState(device);
}

async function getCloudDeviceState(device) {
  await ensureToken(device);

  try {
    const response = await axios.get(device.getUrl, {
      timeout: requestTimeout,
      headers: {
        "X-Gizwits-Application-Id": heatzy_Application_Id,
        "X-Gizwits-User-token": device.heatzyToken,
      },
    });
    if (response.status != 200) {
      device.log(
        `${response.status} ${response.statusText} ${response.data.error_message}`
      );
      return null;
    }
    return stateFromAttrs(device, response.data.attr.mode, response.data.attr.timer_switch);
  } catch (error) {
    if (error && error.response && error.response.status == 400) {
      // Token probably revoked: force a new login on next request
      device.heatzyTokenExpire_at = Date.now() - 10000;
    }
    device.log("Error : " + describeError(error));
    return null;
  }
}

async function setTargetState(device, state) {
  device.lastWriteLocal = false;
  if (device.local) {
    try {
      state = await setLocalTargetState(device, state);
      setLocalWorking(device, true);
      device.lastWriteLocal = true;
      return state;
    } catch (error) {
      setLocalWorking(device, false, error);
    }
  }
  return setCloudTargetState(device, state);
}

async function setCloudTargetState(device, state) {
  state = await setTargetProgState(device, state);
  if (state !== 3 && state !== null) {
    state = await setTargetMode(device, state);
  }
  return state;
}

async function sendCommand(device, attrs) {
  await ensureToken(device);

  try {
    const response = await axios({
      method: "post",
      url: device.postUrl,
      timeout: requestTimeout,
      headers: {
        "X-Gizwits-Application-Id": heatzy_Application_Id,
        "X-Gizwits-User-token": device.heatzyToken,
      },
      data: {
        attrs: attrs,
      },
    });
    if (response.status != 200) {
      device.log(
        "Error - returned code not 200: " +
        response.status +
        " " +
        response.statusText +
        " " +
        response.data.error_message
      );
      return false;
    }
    return true;
  } catch (error) {
    device.log("Error : " + describeError(error));
    return false;
  }
}

async function setTargetMode(device, state) {
  const mode = (state === 0) ? "stop" : (state === 1 ? "cft" : "eco");
  return (await sendCommand(device, { mode: mode })) ? state : null;
}

async function setTargetProgState(device, state) {
  const timer_switch = state === 3 ? 1 : 0;
  return (await sendCommand(device, { timer_switch: timer_switch })) ? state : null;
}

// Reads the state from Heatzy and notifies HomeKit of any change.
// Concurrent calls share the same request. Never rejects.
ThermostatAccessory.prototype.refreshState = function () {
  if (!this.refreshing) {
    this.refreshing = (async () => {
      try {
        const state = await getDeviceState(this);
        this.reachable = state !== null;
        // Heatzy servers may still return the previous state just after a change made from HomeKit
        if (state !== null && Date.now() >= this.ignoreUpdatesUntil) {
          this.applyState(state.current, state.target);
        }
      } catch (error) {
        this.reachable = false;
        this.log("Error : " + describeError(error));
      } finally {
        this.refreshing = null;
      }
    })();
  }
  return this.refreshing;
};

ThermostatAccessory.prototype.applyState = function (current_state, target_state) {
  if (current_state !== this.current_state) {
    if (this.current_state !== null) {
      this.log("Current state has changed from: " + this.current_state + " to " + current_state);
    }
    this.current_state = current_state;
    this.service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, current_state);
  }

  if (target_state !== this.target_state) {
    if (this.target_state !== null) {
      this.log("Target state has changed from: " + this.target_state + " to " + target_state);
    }
    this.target_state = target_state;
    this.service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, target_state);
  }
};

ThermostatAccessory.prototype.updateState = function () {
  return this.refreshState();
};

// Answers from the cached state when it is fresh, and refreshes it in the background:
// HomeKit is notified through updateCharacteristic if it has changed
ThermostatAccessory.prototype.getCachedState = async function (key) {
  if (this[key] === null || !this.reachable) {
    await this.refreshState();
  } else {
    this.refreshState();
  }
  return this.reachable ? this[key] : null;
};

ThermostatAccessory.prototype.handleCurrentHeatingCoolingStateGet = async function (
  callback
) {
  const state = await this.getCachedState("current_state");
  if (this.trace) {
    this.log("HomeKit asked for current state (0 for stop or fro, 1 for cft, 2 for eco): " + state);
  }
  if (state !== null) {
    callback(null, state);
  } else {
    this.log("Error : Unavailable state");
    callback(new Error("Unavailable state"));
  }
};

ThermostatAccessory.prototype.handleTargetHeatingCoolingStateGet = async function (
  callback
) {
  const state = await this.getCachedState("target_state");
  if (this.trace) {
    this.log("HomeKit asked for target state (0 for stop or fro, 1 for cft, 2 for eco, 3 for prog): " + state);
  }
  if (state !== null) {
    callback(null, state);
  } else {
    this.log("Error : Unavailable state");
    callback(new Error("Unavailable state"));
  }
};

ThermostatAccessory.prototype.handleTargetHeatingCoolingStateSet = async function (
  value,
  callback
) {
  const state = await setTargetState(this, value);
  if (this.trace) {
    this.log("HomeKit changed target state to (0 for stop or fro, 1 for cft, 2 for eco, 3 for prog): " + state);
  }
  clearTimeout(this.confirmTimer);
  if (state === null) {
    this.log("Error - Cannot change state");
    callback(new Error("Cannot change state"));
    this.ignoreUpdatesUntil = 0;
    this.refreshState(); // The command may have been partially applied: show the real state
    return;
  }

  callback(null);
  const delay = this.lastWriteLocal ? localConfirmDelay : confirmDelay;
  this.ignoreUpdatesUntil = Date.now() + delay;
  this.target_state = state;
  if (state !== Characteristic.TargetHeatingCoolingState.AUTO) {
    this.applyState(state, state);
  }
  // Read the real state once the device (or Heatzy servers) has taken the change into account
  this.confirmTimer = setTimeout(this.refreshState.bind(this), delay + 100);
};

ThermostatAccessory.prototype.handleCurrentTemperatureGet = function (
  callback
) {
  if (this.trace) {
    this.log("Give fake current temp of " + this.fake_temp + "°");
  }
  callback(null, this.fake_temp);
};

ThermostatAccessory.prototype.handleTargetTemperatureGet = function (
  callback
) {
  if (this.trace) {
    this.log("Give fake target temp of " + this.fake_temp + "°");
  }
  callback(null, this.fake_temp);
};

ThermostatAccessory.prototype.handleTargetTemperatureSet = function (
  value,
  callback
) {
  if (this.trace) {
    this.log("HomeKit tried to set target temp to " + value + "°, ignored: fake temp stays " + this.fake_temp + "°");
  }
  callback(null);
  // The target temperature is fake: show the configured value again
  setTimeout(() => {
    this.service.updateCharacteristic(Characteristic.TargetTemperature, this.fake_temp);
  }, 1000);
};

ThermostatAccessory.prototype.handleTemperatureDisplayUnitsGet = function (
  callback
) {
  if (this.trace) {
    this.log("Get fake temp unit (0 for °C, 1 for °F): " + this.temp_unit);
  }
  callback(null, this.temp_unit);
};

ThermostatAccessory.prototype.handleTemperatureDisplayUnitsSet = function (
  value,
  callback
) {
  if (this.trace) {
    this.log("HomeKit tried to set temp unit to " + value + ", ignored: fake temp unit stays (0 for °C, 1 for °F) " + this.temp_unit);
  }
  callback(null);
  setTimeout(() => {
    this.service.updateCharacteristic(Characteristic.TemperatureDisplayUnits, this.temp_unit);
  }, 1000);
};

ThermostatAccessory.prototype.getServices = function () {
  this.log("Init Services...");
  return [this.service, this.informationService];
};
