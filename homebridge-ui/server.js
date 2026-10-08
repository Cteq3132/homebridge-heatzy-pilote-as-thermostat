"use strict";

// Server side of the setup UI (Homebridge Config UI X): signs in to Heatzy, lists the devices,
// and saves the local network passcode of each device in Homebridge storage.
// The passcode never goes to the browser, and the password is only sent to Heatzy servers

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const lan = require("../lan");

const heatzyUrl = "https://euapi.gizwits.com/app/";
const heatzy_Application_Id = "c70a66ff039d41b4a220e198b0fcc8b3";
const requestTimeout = 10000; // ms
const PLATFORM_NAME = "HeatzyPilote";

function heatzyError(error) {
  if (error && error.response && error.response.data && error.response.data.error_message) {
    return error.response.data.error_message;
  }
  return error && error.message ? error.message : String(error);
}

// Heaters configured in the "accessories" section, before version 2
function isLegacyBlock(block) {
  return !!block && typeof block.accessory === "string" &&
    (block.accessory === PLATFORM_NAME || block.accessory.endsWith("." + PLATFORM_NAME));
}

(async () => {
  // @homebridge/plugin-ui-utils is an ES module
  const { HomebridgePluginUiServer, RequestError } = await import("@homebridge/plugin-ui-utils");

  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.onRequest("/login", this.login.bind(this));
      this.onRequest("/devices", this.getDevices.bind(this));
      this.onRequest("/legacy", this.getLegacyBlocks.bind(this));
      this.onRequest("/legacy/remove", this.removeLegacyBlocks.bind(this));
      this.ready();
    }

    // Returns the token only: the password is not kept anywhere
    async login({ username, password }) {
      try {
        const response = await axios.post(heatzyUrl + "login", { username, password, lang: "en" }, {
          timeout: requestTimeout,
          headers: { "X-Gizwits-Application-Id": heatzy_Application_Id },
        });
        return { token: response.data.token, expire_at: response.data.expire_at };
      } catch (error) {
        throw new RequestError("Heatzy sign in failed: " + heatzyError(error), { status: 401 });
      }
    }

    async getDevices({ token }) {
      const get = async (endpoint) => (await axios.get(heatzyUrl + endpoint, {
        timeout: requestTimeout,
        headers: { "X-Gizwits-Application-Id": heatzy_Application_Id, "X-Gizwits-User-token": token },
      })).data;

      try {
        const bindings = [];
        for (let skip = 0; ; skip += 20) {
          const devices = (await get("bindings?limit=20&skip=" + skip)).devices || [];
          bindings.push(...devices);
          if (devices.length < 20) break;
        }

        const schemas = {};
        const result = [];
        for (const binding of bindings) {
          if (!(binding.product_key in schemas)) {
            schemas[binding.product_key] = lan.compactSchema(await get("datapoint?product_key=" + binding.product_key));
          }
          const schema = schemas[binding.product_key];
          const local = !!(schema && binding.passcode);
          this.saveLocalState(binding.did, local
            ? { passcode: binding.passcode, mac: binding.mac, ip: binding.lan_ip || null, schema }
            : { unsupported: true });
          result.push({
            did: binding.did,
            alias: binding.dev_alias,
            product: binding.product_name,
            online: !!binding.is_online,
            local,
          });
        }
        return result;
      } catch (error) {
        throw new RequestError("Cannot get the devices from Heatzy: " + heatzyError(error), { status: 502 });
      }
    }

    // Same file as the plugin uses (index.js, localStateFile)
    saveLocalState(did, state) {
      const dir = path.join(this.homebridgeStoragePath, "heatzy-pilote");
      const file = path.join(dir, did + ".json");
      let previous = {};
      try {
        previous = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        // No previous state
      }
      // Keep the IP found by the plugin on the local network
      if (previous.ip && !state.ip && !state.unsupported) state.ip = previous.ip;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    }

    readConfig() {
      return JSON.parse(fs.readFileSync(this.homebridgeConfigPath, "utf8"));
    }

    // The settings page only sees the "platforms" section: the heaters of version 1 are read here to be migrated
    async getLegacyBlocks() {
      try {
        const config = this.readConfig();
        return (config.accessories || []).filter(isLegacyBlock);
      } catch (error) {
        throw new RequestError("Cannot read the Homebridge config: " + error.message, { status: 500 });
      }
    }

    // Called once the heaters have been saved in the platform: removes them, and their password, from "accessories"
    async removeLegacyBlocks() {
      try {
        const config = this.readConfig();
        const accessories = config.accessories || [];
        const kept = accessories.filter((block) => !isLegacyBlock(block));
        if (kept.length !== accessories.length) {
          config.accessories = kept;
          fs.writeFileSync(this.homebridgeConfigPath, JSON.stringify(config, null, 4));
        }
        return { removed: accessories.length - kept.length };
      } catch (error) {
        throw new RequestError("Cannot update the Homebridge config: " + error.message, { status: 500 });
      }
    }
  }

  return new UiServer();
})();
