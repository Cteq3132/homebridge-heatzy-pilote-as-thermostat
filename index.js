"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const lan = require("./lan");

// From Heatzy API : https://drive.google.com/drive/folders/0B9nVzuTl4YMOaXAzRnRhdXVma1k
// https://heatzy.com/blog/tout-sur-heatzy
const heatzyUrl = "https://euapi.gizwits.com/app/";
const heatzy_Application_Id = "c70a66ff039d41b4a220e198b0fcc8b3";
const requestTimeout = 10000; // ms, without it a request to Heatzy servers can hang forever
const confirmDelay = 10000; // ms, time for Heatzy servers to reflect a change made from HomeKit
const localConfirmDelay = 1000; // ms, a change made on the local network is reflected at once
const localInfoRetryDelay = 10 * 60 * 1000; // ms, between two attempts to get the passcode from Heatzy servers
const discoveryRetryDelay = 5 * 60 * 1000; // ms, between two searches of the device on the local network
const tokenWarningDelay = 14 * 24 * 3600 * 1000; // ms, warn at startup when the token expires sooner

const PLUGIN_NAME = require("./package.json").name;
const PLATFORM_NAME = "HeatzyPilote";

let Service, Characteristic, HapStatusError, HAPStatus, storagePath;

// UUIDs of the heaters still configured in the "accessories" section (before version 2),
// so that the platform does not publish them a second time
const legacyUuids = new Set();

module.exports = (api) => {
  /* this is the starting point for the plugin where we register the platform */
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  HapStatusError = api.hap.HapStatusError;
  HAPStatus = api.hap.HAPStatus;
  storagePath = path.join(api.user.storagePath(), "heatzy-pilote");
  api.registerPlatform(PLATFORM_NAME, HeatzyPlatform);
  // Configurations made before version 2 keep working until they are migrated by the setup UI
  api.registerAccessory(PLATFORM_NAME, LegacyAccessory);
};

// The UUID that Homebridge gave to the heater when it was an accessory (before version 2):
// keeping it keeps the rooms, scenes and automations of the heater in HomeKit
function heaterUuid(api, name) {
  return api.hap.uuid.generate(PLATFORM_NAME + ":" + name);
}

// Logs of a heater, prefixed with its name
function heaterLog(log, name) {
  const prefix = "[" + name + "] ";
  const heater = (message) => log.info(prefix + message);
  heater.info = heater;
  heater.warn = (message) => log.warn(prefix + message);
  heater.error = (message) => log.error(prefix + message);
  return heater;
}

function HeatzyPlatform(log, config, api) {
  this.log = log;
  this.config = config || {};
  this.api = api;
  this.cachedAccessories = new Map();
  this.legacyDuplicates = [];
  this.heaters = [];

  api.on("didFinishLaunching", () => this.publishHeaters());
  api.on("shutdown", () => this.heaters.forEach((heater) => heater.stop()));
}

// Called by Homebridge for each heater restored from its cache
HeatzyPlatform.prototype.configureAccessory = function (accessory) {
  // Configured again in the accessories section: two accessories with the same UUID cannot be published
  if (legacyUuids.has(accessory.UUID)) {
    this.legacyDuplicates.push(accessory);
    return;
  }
  this.cachedAccessories.set(accessory.UUID, accessory);
};

HeatzyPlatform.prototype.publishHeaters = function () {
  // Homebridge 1 restores them next to the heater of the accessories section, Homebridge 2 drops them
  for (const accessory of this.legacyDuplicates) {
    try {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } catch (error) {
      // Not on the bridge
    }
  }

  const devices = Array.isArray(this.config.devices) ? this.config.devices : [];
  const auth = new TokenAuth(this.log, this.config.token, this.config.token_expire_at);
  if (devices.length === 0) {
    this.log.warn("No heater configured: open the plugin settings to add your Heatzy devices");
  } else {
    auth.logValidity();
  }

  const published = new Set();
  const added = [];
  for (const device of devices) {
    if (!device || !device.name || !device.did) {
      this.log.error("A heater is missing its name or its did, ignored: " + JSON.stringify(device && device.name));
      continue;
    }
    const uuid = heaterUuid(this.api, device.uuid_base || device.name);
    if (legacyUuids.has(uuid)) {
      this.log.warn("[" + device.name + "] Also configured in the accessories section, ignored here");
      continue;
    }
    if (published.has(uuid)) {
      this.log.error("[" + device.name + "] Two heaters have this name, the second one is ignored");
      continue;
    }
    published.add(uuid);

    let accessory = this.cachedAccessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(device.name, uuid);
      added.push(accessory);
    }
    accessory.context.did = device.did;
    const service = accessory.getService(Service.Thermostat) || accessory.addService(Service.Thermostat, device.name);
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, "Heatzy")
      .setCharacteristic(Characteristic.Model, "Heatzy Pilote V2")
      .setCharacteristic(Characteristic.SerialNumber, device.did);
    this.heaters.push(new HeatzyThermostat(heaterLog(this.log, device.name), device, auth, service));
  }

  if (added.length > 0) {
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, added);
  }
  const removed = [...this.cachedAccessories.values()].filter((accessory) => !published.has(accessory.UUID));
  if (removed.length > 0) {
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, removed);
  }
};

// A heater configured in the "accessories" section, before version 2
function LegacyAccessory(log, config, api) {
  legacyUuids.add(heaterUuid(api, config.uuid_base || config.name));
  log.warn(
    "This heater uses the configuration of version 1, with your Heatzy password. " +
    "Open the plugin settings in Homebridge UI and click Save to migrate it: only a token will be kept"
  );
  this.informationService = new Service.AccessoryInformation()
    .setCharacteristic(Characteristic.Manufacturer, "Heatzy")
    .setCharacteristic(Characteristic.Model, "Heatzy Pilote V2")
    .setCharacteristic(Characteristic.SerialNumber, config.did || "unknown");
  const auth = new PasswordAuth(log, config.username, config.password);
  this.heater = new HeatzyThermostat(log, config, auth, new Service.Thermostat(config.name));
  api.on("shutdown", () => this.heater.stop());
}

LegacyAccessory.prototype.getServices = function () {
  return [this.informationService, this.heater.service];
};

// Heatzy token saved in the config by the setup UI: the account password is never stored.
// It cannot be renewed without the password: once expired, only the local mode works
function TokenAuth(log, token, expireAt) {
  this.log = log;
  this.token = token || null;
  this.expireAt = expireAt ? expireAt * 1000 : Infinity;
  this.warned = false;
}

TokenAuth.prototype.logValidity = function () {
  if (!this.token) {
    this.warned = true;
    this.log.warn("No Heatzy token, Heatzy servers cannot be used: open the plugin settings and sign in to your Heatzy account");
  } else if (this.expireAt === Infinity) {
    this.log.info("Heatzy token without expiry date");
  } else if (this.expireAt <= Date.now()) {
    this.warned = true;
    this.log.warn("The Heatzy token expired on " + new Date(this.expireAt).toLocaleString() +
      ", Heatzy servers cannot be used: open the plugin settings and sign in again");
  } else if (this.expireAt < Date.now() + tokenWarningDelay) {
    this.log.warn("The Heatzy token expires on " + new Date(this.expireAt).toLocaleString() +
      ": open the plugin settings and sign in again");
  } else {
    this.log.info("Heatzy token valid until " + new Date(this.expireAt).toLocaleString());
  }
};

// Returns the token, or null when there is none
TokenAuth.prototype.getToken = async function () {
  if (this.token && Date.now() < this.expireAt) return this.token;
  if (!this.warned) {
    this.warned = true;
    this.log.warn((this.token ? "The Heatzy token has expired" : "No Heatzy token") +
      ", Heatzy servers cannot be used: open the plugin settings and sign in to your Heatzy account");
  }
  return null;
};

// Heatzy servers answered 400: the token may have been revoked
TokenAuth.prototype.rejected = function () {
  if (!this.warned) {
    this.warned = true;
    this.log.warn("Heatzy servers rejected the request: if the token is no longer valid, " +
      "open the plugin settings and sign in to your Heatzy account");
  }
};

// Login with the email and password of the Heatzy account (configuration of version 1)
function PasswordAuth(log, username, password) {
  this.log = log;
  this.username = username;
  this.password = password;
  this.token = null;
  this.expireAt = 0;
}

PasswordAuth.prototype.getToken = async function () {
  if (this.expireAt < Date.now()) {
    try {
      const response = await axios.post(heatzyUrl + "login", {
        username: this.username,
        password: this.password,
        lang: "en",
      }, {
        timeout: requestTimeout,
        headers: { "X-Gizwits-Application-Id": heatzy_Application_Id },
      });
      this.token = response.data.token;
      this.expireAt = response.data.expire_at * 1000;
    } catch (error) {
      // Never throw from here: an exception would become an unhandled rejection and crash Homebridge
      this.log("Error : " + describeError(error));
      this.log("Error - Plugin unable to login to Heatzy server");
      return null;
    }
  }
  return this.token;
};

// Token probably revoked: force a new login on next request
PasswordAuth.prototype.rejected = function () {
  this.expireAt = 0;
};

function HeatzyThermostat(log, config, auth, service) {
  this.log = log;
  this.config = config;
  this.auth = auth;
  this.service = service;

  // Config
  this.getUrl = heatzyUrl + "devdata/" + config["did"] + "/latest";
  this.postUrl = heatzyUrl + "control/" + config["did"];
  this.name = config["name"];
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

  this.current_state = null;
  this.target_state = null;
  this.reachable = false;
  this.refreshing = null;
  this.ignoreUpdatesUntil = 0;
  this.confirmTimer = null;

  this.service
    .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this));

  this.service
    .getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
    .onSet(this.handleTargetHeatingCoolingStateSet.bind(this));

  this.service
    .getCharacteristic(Characteristic.CurrentTemperature)
    .onGet(this.handleCurrentTemperatureGet.bind(this));

  this.service
    .getCharacteristic(Characteristic.TargetTemperature)
    .onGet(this.handleTargetTemperatureGet.bind(this))
    .onSet(this.handleTargetTemperatureSet.bind(this));

  this.service
    .getCharacteristic(Characteristic.TemperatureDisplayUnits)
    .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
    .onSet(this.handleTemperatureDisplayUnitsSet.bind(this));

  this.updateState(); // Get the current state of the device, and update HomeKit
  this.timer = setInterval(this.updateState.bind(this), this.interval * 1000); // The state of the device will be checked every this.interval seconds
  this.log("starting HeatzyPilote...");
}

HeatzyThermostat.prototype.stop = function () {
  clearInterval(this.timer);
  clearTimeout(this.confirmTimer);
};

function heatzyHeaders(token) {
  return {
    "X-Gizwits-Application-Id": heatzy_Application_Id,
    "X-Gizwits-User-token": token,
  };
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
  const token = await device.auth.getToken();
  if (!token) throw new Error("not signed in to Heatzy");
  const response = await axios.get(heatzyUrl + endpoint, {
    timeout: requestTimeout,
    headers: heatzyHeaders(token),
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
  const token = await device.auth.getToken();
  if (!token) return null;

  try {
    const response = await axios.get(device.getUrl, {
      timeout: requestTimeout,
      headers: heatzyHeaders(token),
    });
    return stateFromAttrs(device, response.data.attr.mode, response.data.attr.timer_switch);
  } catch (error) {
    if (error && error.response && error.response.status == 400) {
      device.auth.rejected();
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
  const token = await device.auth.getToken();
  if (!token) return false;

  try {
    await axios.post(device.postUrl, { attrs: attrs }, {
      timeout: requestTimeout,
      headers: heatzyHeaders(token),
    });
    return true;
  } catch (error) {
    if (error && error.response && error.response.status == 400) {
      device.auth.rejected();
    }
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
HeatzyThermostat.prototype.refreshState = function () {
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

HeatzyThermostat.prototype.applyState = function (current_state, target_state) {
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

HeatzyThermostat.prototype.updateState = function () {
  return this.refreshState();
};

// Answers from the cached state when it is fresh, and refreshes it in the background:
// HomeKit is notified through updateCharacteristic if it has changed
HeatzyThermostat.prototype.getCachedState = async function (key) {
  if (this[key] === null || !this.reachable) {
    await this.refreshState();
  } else {
    this.refreshState();
  }
  return this.reachable ? this[key] : null;
};

HeatzyThermostat.prototype.handleCurrentHeatingCoolingStateGet = async function () {
  const state = await this.getCachedState("current_state");
  if (this.trace) {
    this.log("HomeKit asked for current state (0 for stop or fro, 1 for cft, 2 for eco): " + state);
  }
  if (state === null) {
    this.log("Error : Unavailable state");
    throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
  return state;
};

HeatzyThermostat.prototype.handleTargetHeatingCoolingStateGet = async function () {
  const state = await this.getCachedState("target_state");
  if (this.trace) {
    this.log("HomeKit asked for target state (0 for stop or fro, 1 for cft, 2 for eco, 3 for prog): " + state);
  }
  if (state === null) {
    this.log("Error : Unavailable state");
    throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
  return state;
};

HeatzyThermostat.prototype.handleTargetHeatingCoolingStateSet = async function (value) {
  const state = await setTargetState(this, value);
  if (this.trace) {
    this.log("HomeKit changed target state to (0 for stop or fro, 1 for cft, 2 for eco, 3 for prog): " + state);
  }
  clearTimeout(this.confirmTimer);
  if (state === null) {
    this.log("Error - Cannot change state");
    this.ignoreUpdatesUntil = 0;
    this.refreshState(); // The command may have been partially applied: show the real state
    throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  const delay = this.lastWriteLocal ? localConfirmDelay : confirmDelay;
  this.ignoreUpdatesUntil = Date.now() + delay;
  this.target_state = state;
  if (state !== Characteristic.TargetHeatingCoolingState.AUTO) {
    this.applyState(state, state);
  }
  // Read the real state once the device (or Heatzy servers) has taken the change into account
  this.confirmTimer = setTimeout(this.refreshState.bind(this), delay + 100);
};

HeatzyThermostat.prototype.handleCurrentTemperatureGet = function () {
  if (this.trace) {
    this.log("Give fake current temp of " + this.fake_temp + "°");
  }
  return this.fake_temp;
};

HeatzyThermostat.prototype.handleTargetTemperatureGet = function () {
  if (this.trace) {
    this.log("Give fake target temp of " + this.fake_temp + "°");
  }
  return this.fake_temp;
};

HeatzyThermostat.prototype.handleTargetTemperatureSet = function (value) {
  if (this.trace) {
    this.log("HomeKit tried to set target temp to " + value + "°, ignored: fake temp stays " + this.fake_temp + "°");
  }
  // The target temperature is fake: show the configured value again
  setTimeout(() => {
    this.service.updateCharacteristic(Characteristic.TargetTemperature, this.fake_temp);
  }, 1000);
};

HeatzyThermostat.prototype.handleTemperatureDisplayUnitsGet = function () {
  if (this.trace) {
    this.log("Get fake temp unit (0 for °C, 1 for °F): " + this.temp_unit);
  }
  return this.temp_unit;
};

HeatzyThermostat.prototype.handleTemperatureDisplayUnitsSet = function (value) {
  if (this.trace) {
    this.log("HomeKit tried to set temp unit to " + value + ", ignored: fake temp unit stays (0 for °C, 1 for °F) " + this.temp_unit);
  }
  setTimeout(() => {
    this.service.updateCharacteristic(Characteristic.TemperatureDisplayUnits, this.temp_unit);
  }, 1000);
};
