"use strict";

const url = require("url");
const axios = require("axios");

// From Heatzy API : https://drive.google.com/drive/folders/0B9nVzuTl4YMOaXAzRnRhdXVma1k
// https://heatzy.com/blog/tout-sur-heatzy
const heatzyUrl = "https://euapi.gizwits.com/app/";
const loginUrl = url.parse(heatzyUrl + "login");
const heatzy_Application_Id = "c70a66ff039d41b4a220e198b0fcc8b3";
const requestTimeout = 10000; // ms, without it a request to Heatzy servers can hang forever
const confirmDelay = 10000; // ms, time for Heatzy servers to reflect a change made from HomeKit

let Service, Characteristic;

module.exports = (homebridge) => {
  /* this is the starting point for the plugin where we register the accessory */
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
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

// Returns { current, target }, or null if the state could not be read
async function getDeviceState(device) {
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
    const current = modeToState(device, response.data.attr.mode);
    const target = response.data.attr.timer_switch == 1
      ? Characteristic.TargetHeatingCoolingState.AUTO
      : current;
    return { current, target };
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
  this.ignoreUpdatesUntil = Date.now() + confirmDelay;
  this.target_state = state;
  if (state !== Characteristic.TargetHeatingCoolingState.AUTO) {
    this.applyState(state, state);
  }
  // Read the real state once Heatzy servers have taken the change into account
  this.confirmTimer = setTimeout(this.refreshState.bind(this), confirmDelay + 100);
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
