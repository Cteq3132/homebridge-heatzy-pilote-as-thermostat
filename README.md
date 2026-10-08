# homebridge-heatzy-pilote-as-thermostat

Homebridge plugin for Heatzy devices, considered as thermostats.
 
Heatzy uses the 'fil pilote' protocol to control an electric heater, with 4 states : 

* Confort  : temperature set on the heater
* Eco : temperature 3°C to 4°C below Confort
* Hors-gel : temperature set to ~7°C
* Off.

The switch from a state to another can be automated within the official application, by creating a schedule.

In this plugin, every Heatzy device is a thermostat, with these values : 

* `Off` : Off
* `Heat` : Confort
* `Cool` : Eco
* `Auto` : Turn on the automation created in the app

If you set the device from the Home app, `Off` will set the heater to off, `Heat` to Confort, `Cool` to Eco and `Auto` will activate the last automation program that you used.
If you set it from the Heatzy app, or from the hardware button, Confort will be displayed in the Home app as `Heat`, Eco as `Cool` and Prog as `Auto`. Any other state (Hors-Gel or Off) will be displayed as `Off`.

For the rest of the functionnalities of the thermostat in the Home app, everything is fake : a fake current temperature, target temperature and temperature unit, choosen in the config.json, is set by default, and will always stay the same. If you try to change the target temperature from the Home app, nothing will happened, as well as if you try to change the temperature unit from °C to °F.


## Installation

Install or update this plugin using `npm i -g @cteq3132/homebridge-heatzy-pilote-as-thermostat`.

The easiest way to configure it is the plugin settings in [Homebridge UI](https://github.com/homebridge/homebridge-config-ui-x): sign in with your Heatzy account, click `Find my devices`, choose the devices to add and save. This also gets the local network passcode of your devices (see [Local mode](#local-mode)).

You can also update the `config.json` file of your Homebridge setup, by modifying the sample configuration below.


## Local mode

The plugin controls your devices directly on your local network, with the Gizwits LAN protocol used by Heatzy devices (TCP port 12416). It is faster than Heatzy servers, and keeps working when Heatzy servers or your internet connection are down.

This needs the local network passcode of each device, which can only be obtained from Heatzy servers. It is fetched once, by the setup UI or by the plugin at its first start, and saved in the Homebridge storage folder (`heatzy-pilote/<did>.json`). After that, Heatzy servers are only used as a fallback, when the device cannot be reached on the local network.

The IP address of the device is found automatically on your local network. You can also set it with the `ip` parameter (with a DHCP reservation on your router).

Tested with the Heatzy Pilote (`Pilote_Soc_C3`). Devices that do not support it are controlled through Heatzy servers, as before.


## Configurations

The configuration parameters to enable your devices would need to be added to `accessories` section of the Homebridge configuration file. One block is necessary for each Heatzy device.

```json5
{
    ...
            "accessories": [
                {
                    "accessory": "HeatzyPilote",
                    "name": "Bedroom heater",
                    "username": "XXX",
                    "password": "XXX",
                    "did": "011233455677899abbcd",
                    "interval": 60,
                    "fake_temp": 20,
                    "temp_unit": "C",
                    "local": true,
                    "trace" : false
                }
            ]
    ...
}
```


#### Parameters

* `accessory ` is required, with `HeatzyPilote` value.  
* `name` (required) is anything you'd like to use to identify this device. You can always change the name from within the Home app.
* `username` and `password` (required) are the credentials you use in the Heatzy app.
* `did` (required) is the parameter for your device. The setup UI finds it for you, or see below how to get it.
* `interval` (optional) is how often (in seconds) the plugin will ask the device (or Heatzy servers) its state, which is necessary when you change the state from outside of Homekit. Default is 60s.
* `fake_temp` (optional) the fake temperature displayed in the Home app as current and target temperature. Home app accepts values from 10 to 38. Default is 20°.
* `temp_unit` (optional) the temperature unit used in the Home app, "C" for °C, "F" for °F. Default is °C.
* `local` (optional) controls the device on the local network, see [Local mode](#local-mode). Set to `false` to only use Heatzy servers. Default is true.
* `ip` (optional) the IP address of the device on the local network. Default is to find it automatically.
* `trace` (optional) displays the main events in homebridge log . Default is false.


## How to find the Device ID `did` of your devices

The setup UI in Homebridge UI does this for you. Otherwise, in your terminal, enter the two commands below.

For the first one, you will have to replace USERNAME and PASSWORD by your credentials used in the Heatzy app.
In return, you should get a `token` : you will use it in the second command, to replace YOURTOKEN.

The second command will return many datas. For each Heatzy device, you must find this piece of information : `"did": "011233455677899abbcd"`. To know wich `did` is for which device, you will find another piece of informatation close to it:` "dev_alias": "Name"`. The Name is the one used in the Heatzy app.
(You can choose a different name in homebridge configuration file, if you wish).


`curl -X POST --header 'Content-Type: application/json' --header 'Accept: application/json' --header 'X-Gizwits-Application-Id: c70a66ff039d41b4a220e198b0fcc8b3' -d '{ "username": "USERNAME", "password": "PASSWORD", "lang": "en" }' 'https://euapi.gizwits.com/app/login'`

`curl -X GET --header 'Accept: application/json' --header 'X-Gizwits-User-token: YOURTOKEN' --header 'X-Gizwits-Application-Id: c70a66ff039d41b4a220e198b0fcc8b3' 'https://euapi.gizwits.com/app/bindings?limit=20&skip=0'`


## Publishing a new version

Bump `version` in `package.json` and merge into `master`: the [Publish to npm](.github/workflows/publish.yml) GitHub Action publishes the package if this version is not on npm yet. It uses npm trusted publishing, configured on npmjs.com in the package settings (Trusted Publisher → GitHub Actions, repository `Cteq3132/homebridge-heatzy-pilote-as-thermostat`, workflow `publish.yml`).
