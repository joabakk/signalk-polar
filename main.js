/*
* Copyright 2017-2022 Joachim Bakke
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
const Bacon = require("baconjs")
const util = require("util")
const utilSK = require("@signalk/nmea0183-utilities")
const express = require("express")
const _ = require("lodash")
const Database = require("better-sqlite3")
const uuidv4 = require("uuid/v4")
const parse = require("csv-parse")
const fs = require("fs")
const path = require("path")

var csvList = ["ignore"]

module.exports = function(app, options) {
  "use strict"
  var client
  var selfContext = "vessels." + app.selfId
  var userDir = app.config.configPath
  var plugin = {}
  plugin.id = "signalk-polar"

  var unsubscribes = []
  var shouldStore = function(path) {
    return true
  }

  return {
    id: "signalk-polar",
    name: "Polar storage and retrieval",
    description:
    "Signal K server plugin that stores and retrieves polar data from sqlite3 database",
    uiSchema: {
      dynamic: {
        items:{
          mainPolarUuid: { "ui:widget": "hidden" }
        }
      },
      static: {
        items: {
          polarUuid: { "ui:widget": "hidden" },
          csvTable: { "ui:widget": "textarea" }
        }
      }
    },
    schema: {
      type: "object",
      title:
      "A Signal K (node) plugin to maintain polar diagrams in a sqlite3 database",
      description: "",
      properties: {
        useDynamicPolar: {
          type: "boolean",
          title: "Use dynamic polar diagram (may slow down server)",
          default: false
        },
        dynamic: {
          type: "array",
          title: "Dynamic polar from performance",
          items: {
            title: "",
            type: "object",
            required: ["engine", "sqliteFile"],
            properties: {
              engine: {
                type: "string",
                title:
                "How is engine status monitored - stores to polar only when engine off",
                default: "doNotStore",
                enum: [
                  "alwaysOff",
                  "propulsion.*.revolutions",
                  "propulsion.*.state",
                  "doNotStore"
                ],
                enumNames: [
                  "assume engine always off",
                  "propulsion.*.revolutions > 0",
                  "propulsion.*.state is not 'started'",
                  "do not store dynamic polar"
                ]
              },
              additional_info: {
                type: "string",
                title:
                "replace * in 'propulsion.*.revolutions' or 'propulsion.*.state' with [ ]"
              },
              sqliteFile: {
                type: "string",
                title: "File for storing sqlite3 data, ",
                default: "polarDatabase.db"
              },
              polarName: {
                type: "string",
                title: "Name of the polar diagram",
                default: "dynamicPolar"
              },
              polarDescription: {
                type: "string",
                title: "Description of the polar diagram",
                default: "Dynamic polar diagram from actual sailing"
              },
              mainPolarUuid: {
                type: "string",
                title: "Main polar UUID"
              },
              angleResolution: {
                type: "number",
                title: "angle resolution in degrees",
                default: 1
              },
              twsInterval: {
                type: "number",
                title: "wind speed resolution in m/s",
                default: 4
              },
              maxWind: {
                type: "number",
                title: "max wind speed to record/display, in m/s",
                default: 15
              },
              rateOfTurnLimit: {
                type: "number",
                title:
                "Store in database if rate of turn is unavailable or less than [ ] deg/min (inertia gives false reading while turning vessel)",
                default: 5
              }
            }
          }
        },
        static: {
          type: "array",
          title: "Static user input polars",
          items: {
            title: "",
            type: "object",
            properties: {
              mirror: {
                type: "boolean",
                title: "Mirror polar port and stbd?",
                default: true
              },
              polarName: {
                type: "string",
                title: "Name of polar ('design', 'lastYear' etc)",
                default: "Design"
              },
              description: {
                type: "string",
                title: "further description of the polar"
              },
              polarUuid: {
                type: "string",
                title: "UUID of polar"
              },
              angleUnit: {
                type: "string",
                title: "Unit for wind angle",
                default: "deg",
                enum: ["rad", "deg"],
                enumNames: ["Radians", "Degrees"]
              },
              windSpeedUnit: {
                type: "string",
                title: "Unit for wind speed",
                default: "knots",
                enum: ["knots", "ms", "kph", "mph"],
                enumNames: ["Knots", "m/s", "km/h", "mph"]
              },
              boatSpeedUnit: {
                type: "string",
                title: "Unit for boat speed",
                default: "knots",
                enum: ["knots", "ms", "kph", "mph"],
                enumNames: ["Knots", "m/s", "km/h", "mph"]
              },
              csvPreset: {
                type: "string",
                title: "Preset polars from https://github.com/seandepagnier/weather_routing_pi (server restart...?)",
                default: "ignore",
                enum: csvList,
                enumNames: csvList
              },
              csvTable: {
                type: "string",
                title:
                "OR enter csv with polar in http://jieter.github.io/orc-data/site/ style"
              }
            }
          }
        },
        updateTables: {
          type: "boolean",
          title: "Update all tables (enable after making changes)",
          default: false
        }
      }
    },

    start: function(options) {
      app.debug('started plugin')

      var csvFolder = path.join(userDir, '/node_modules/', plugin.id, '/seandepagnier')
      if (!fs.existsSync(csvFolder)) {
        fs.mkdirSync(csvFolder)
      }
      fs.readdirSync(csvFolder).forEach(file => {
        if (file != 'Example' && file != 'Additional'){
          csvList.push(file)
        }
      })

      if (options.updateTables){
        //update tables and JSON files
        if (options.static && options.static.length > 0) {
          var counter = 0
          options.static.forEach(table => {
            var tableName = table.polarName.replace(/ /gi, "_")
            var tableUuid
            if (table.polarUuid) {
              tableUuid = table.polarUuid
              //app.debug("Polar uuid exists: '" + tableUuid + "'", typeof(tableUuid))
            } else {
              tableUuid = uuidv4()
              options.static[counter].polarUuid = tableUuid
              app.debug("Polar uuid does not exist, creating '" + tableUuid + "'")
              app.savePluginOptions(options, function(err, result) {
                if (err) {
                  console.log(err)
                }
              })
            }
            var description
            if (table.description) {
              description = table.description
            } else {
              description =  ''
            }

            app.debug("polar name is " + tableName)

            var output = []
            var delimiter, lineBreak, csvTable
            if(!table.csvTable && table.csvPreset && table.csvPreset != "ignore"){
              //console.log(table.csvPreset)
              var extension = path.extname(table.csvPreset)
              //app.debug("extension: " + extension)
              var data = fs.readFileSync(path.join(userDir, '/node_modules/', plugin.id, '/seandepagnier/', table.csvPreset), 'utf8', function (err, data) {
                if (err) {
                  console.log(err);
                  process.exit(1);
                }
              })
              var csvStrBack
              if (extension == '.txt'){
                csvStrBack = data.split('\n').slice(1).join('\n')
              }
              else if (extension == '.pol'){
                csvStrBack = data
              }


              var csvStr = csvStrBack.replace(/\\/g, '/')
              console.log('csvStr: ' + csvStr)
              if (extension == '.csv'){
                var csvTab = csvStrBack.trim().replace(/\°/g, '')
                csvTable = csvTab.replace(/( [\r,\n]+)|(;\D*\n)|(;\D*[\r,\n]+)/g, '\r\n')
              }
              else if (extension == '.pol'){
                csvTable = csvStr.trim().replace(/(\t+|\t| |\t\t|  )(?!\n| \n|$)/g, ";")
              }
              //app.debug(csvTable)

              options.static[counter].csvTable = csvTable

              app.savePluginOptions(options, function(err, result) {
                if (err) {
                  console.log(err)
                }
              })

            }
            else {
              csvTable = table.csvTable
            }
            delimiter = ";"



            parse(csvTable, {
              trim: true,
              skip_empty_lines: true,
              delimiter: delimiter,
              record_delimiter: lineBreak
            }).on("readable", function() {
              let windData = []
              let record
              while ((record = this.read())) {
                output.push(record)
              }
              console.log(JSON.stringify(output))
              var windSpeeds = []
              var angleData = []
              output[0].forEach(listSpeeds)
              function listSpeeds(item, index) {
                if (index > 0) {
                  //first is "twa/tws"

                  var windSpeedItem = utilSK.transform(item,table.windSpeedUnit,"ms")
                  windSpeeds.push(Number(windSpeedItem))
                }
              }
              //app.debug("windspeeds: " + JSON.stringify(windSpeeds))
              output.forEach(storeSpeeds)
              function storeSpeeds(item, index) {

                if (index > 0) {
                  //first row is header, and already parsed
                  var itemAngle = utilSK.transform(Number(item[0]),table.angleUnit,"rad")
                  //app.debug("itemAngle: " +itemAngle)
                  item.forEach(storeSpeed)
                  function storeSpeed(speedItem, index) {

                    if (!angleData[index]){
                      angleData[index] = []
                    }
                    var speed = utilSK.transform(speedItem,table.boatSpeedUnit,  "ms"  )
                    if (index > 0) {
                      //first item is angle, already parsed
                      var vmg = getVelocityMadeGood(speed, itemAngle)
                      angleData[index-1].push([itemAngle, speed, vmg])
                      if(table.mirror){
                        angleData[index-1].push([-itemAngle, speed, vmg])
                      }

                    }

                  }

                }
              }
              //console.log('windSpeeds:' + util.inspect(windSpeeds))
              windSpeeds.forEach(pushWindData)

              function pushWindData(wind, index){
                console.log('wind: ' + wind + ' index: ' + index)
                windData.push({
                  "trueWindSpeed": wind,
                  "angleData": angleData[index]
                })
              }

              var jsonFormat = {
                [tableUuid]: {
                "id": tableUuid,
                "name": tableName,
                "description": description,
                "source": {
                  "label": "signalk-polar"
                },
                "windData": windData
                }
              }

              //store polar as [uuid].json
              let tableFile = path.join(userDir, 'plugin-config-data', plugin.id, tableUuid)
              tableFile = tableFile.slice(0, -1) + '.json'
              console.log('tableFile: ' + tableFile)
              let jsonStore = JSON.stringify(jsonFormat, null, 2)
              //console.log("jsonStore is: " + typeof(jsonStore))
              //console.log("jsonStore : " + util.inspect(jsonStore))
              fs.writeFile(tableFile, jsonStore, (err) => {
                console.log('writing json file')

                if (err) {
                  console.log(err);
                  process.exit(1);
                }
              })

            })

            counter += 1
          })
        }

        //now disable the function again
        options.updateTables = false
        app.savePluginOptions(options, function(err, result) {
          if (err) {
            console.log(err)
          }
        })
      }

      if (options.useDynamicPolar){
        //handle deltas

      }


    },

    registerWithRouter: function(router) {},
    stop: function() {}
  }

}
module.exports.app = "app"
module.exports.options = "options"

function getTrueWindAngle(speed, trueWindSpeed, apparentWindspeed, windAngle) {
  // alpha=arccos((A*cos(beta)-V)/W)
  //A is apparent wind speed,
  //beta is apparent wind angle
  //V is boat speed
  //W is true wind speed
  //alpha is true wind angle

  var cosAlpha =
  (apparentWindspeed * Math.cos(windAngle) - speed) / trueWindSpeed

  if (windAngle === 0) {
    return 0
  } else if (windAngle == Math.PI) {
    return Math.PI
  } else if (cosAlpha > 1 || cosAlpha < -1) {
    console.log(
      "invalid triangle aws: " +
      apparentWindspeed +
      " tws: " +
      trueWindSpeed +
      " bsp: " +
      speed
    )
    return null
  } else {
    var calc
    if (windAngle >= 0 && windAngle <= Math.PI) {
      //Starboard
      calc = Math.acos(cosAlpha)
    } else if (windAngle < 0 && windAngle > -Math.PI) {
      //Port
      calc = -Math.acos(cosAlpha)
    }
    //app.debug("true wind angle: " + calc)
    return calc
  }
}

function getTrueWindSpeed(speed, windSpeed, windAngle) {
  return Math.sqrt(
    Math.pow(windSpeed, 2) +
    Math.pow(speed, 2) -
    2 * windSpeed * speed * Math.cos(windAngle)
  )
}

function getVelocityMadeGood(stw, twa) {
  //app.debug("getVelocityMadeGood called")
  return Math.cos(twa) * stw
}

function pushDelta(app, path, value) {
  app.handleMessage(plugin.id, {
    updates: [
      {
        values: [
          {
            path: path,
            value: value
          }
        ]
      }
    ]
  })
  return
}
