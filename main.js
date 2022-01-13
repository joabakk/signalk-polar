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
  var allPolars = {}
  var polarList = []
  var activePolar
  const keyPaths = [
    "performance.velocityMadeGood", // if empty, populate from this plugin
    "navigation.rateOfTurn", // if above threshold, vessel is turning and no data is stored
    "navigation.speedThroughWater",
    "environment.wind.angleApparent",
    "environment.wind.speedApparent",
    "navigation.courseOverGroundTrue",
    "navigation.speedOverGround"
  ]
  var currentVmg, currentRot, currentStw, currentAwa, currentTwa, currentAws, currentCog, currentSog, currentTws


  return {
    id: "signalk-polar",
    name: "Polar storage and retrieval",
    description:
    "Signal K server plugin that stores and retrieves static and/or dynamic polar data",
    uiSchema: {
      activePolar: { "ui:widget": "hidden" },
      dynamic: {
        items:{
          polarUuid: { "ui:widget": "hidden" }
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
          title: "Use dynamic polar diagram (may slow down server). First item will be active polar",
          default: false
        },
        activePolar: {
          type: "string",
          title: "UUID of active polar table",
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
              polarUuid: {
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
                  app.debug(err)
                }
              })
            }
            polarList.push(table.polarUuid)
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
              //app.debug(table.csvPreset)
              var extension = path.extname(table.csvPreset)
              //app.debug("extension: " + extension)
              var data = fs.readFileSync(path.join(userDir, '/node_modules/', plugin.id, '/seandepagnier/', table.csvPreset), 'utf8', function (err, data) {
                if (err) {
                  app.debug(err);
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
              app.debug('csvStr: ' + csvStr)
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
                  app.debug(err)
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
              app.debug(JSON.stringify(output))
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

                    if (!angleData[index-1]){
                      angleData[index-1] = [[0,null,null]]
                    }
                    var speed = utilSK.transform(speedItem,table.boatSpeedUnit,  "ms"  )
                    if (index > 0 && speed != 0) {
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
              //app.debug('windSpeeds:' + util.inspect(windSpeeds))
              windSpeeds.forEach(pushWindData)

              function pushWindData(wind, index){
                app.debug('wind: ' + wind + ' index: ' + index)
                let optimalBeats =[]
                let optimalGybes = []

                function findOptimalBeats(arr) {
                  var bestVmg  = 0
                  var bestOrigin = [];
                  for(var i = 0; i < arr.length; i++){
                    if(arr[i][2] && arr[i][2] > bestVmg){
                      bestVmg = arr[i][2];
                      bestOrigin = [arr[i][0],arr[i][1]];
                    }
                  }
                  if(table.mirror){
                    return [bestOrigin, [-bestOrigin[0], bestOrigin[1]]]
                  } else {
                    return [bestOrigin, null]//@TODO should find port beat
                  }
                }

                function findOptimalGybes(arr) {
                  var bestVmg = 0,
                  bestOrigin = [];
                  for(var i = 0; i < arr.length; i++){
                    if(arr[i][2] && arr[i][2] < bestVmg){
                      bestVmg = arr[i][2];
                      bestOrigin = [arr[i][0],arr[i][1]];
                    }
                  }
                  if(table.mirror){
                    return [bestOrigin, [-bestOrigin[0], bestOrigin[1]]]
                  } else {
                    return [bestOrigin, null]//@TODO should find port gybe
                  }
                }

                optimalBeats = findOptimalBeats(angleData[index])
                optimalGybes = findOptimalGybes(angleData[index])


                windData.push({
                  "trueWindSpeed": wind,
                  "optimalBeats": optimalBeats,
                  "optimalGybes": optimalGybes,
                  "angleData": angleData[index].sort((a, b) => a[0] - b[0])
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
              app.debug('tableFile: ' + tableFile)
              let jsonStore = JSON.stringify(jsonFormat, null, 2)
              //app.debug("jsonStore is: " + typeof(jsonStore))
              //app.debug("jsonStore : " + util.inspect(jsonStore))
              fs.writeFile(tableFile, jsonStore, (err) => {
                app.debug('writing json file')

                if (err) {
                  app.debug(err);
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
            app.debug(err)
          }
        })
      }

      if (options.useDynamicPolar){
        var mainPolarUuid
        if (options.dynamic[0].polarUuid) {
          mainPolarUuid = options.dynamic[0].polarUuid
          app.debug("Polar uuid exists: " + mainPolarUuid, typeof mainPolarUuid)
        } else {
          mainPolarUuid = uuidv4()
          options.dynamic[0].polarUuid = mainPolarUuid
          app.debug("Polar uuid does not exist, creating " + mainPolarUuid)
          app.savePluginOptions(options, function(err, result) {
            if (err) {
              app.debug(err)
            }
          })
        }

        //handle deltas

        //use the dynamic polar as active
        activePolar = options.dynamic[0].polarUuid
        polarList.push(mainPolarUuid)
        options.activePolar = activePolar
        app.debug('active Polar: ' + options.activePolar)
        app.savePluginOptions(options, function(err, result) {
          if (err) {
            app.debug(err)
          }
        })
      }

      else if(options.static) {
        options.static.forEach(table => {
          polarList.push(table.polarUuid)
        })
        if (options.static.length  == 1){
          activePolar = options.static[0].polarUuid
          options.activePolar = activePolar
          app.debug('active Polar: ' + options.activePolar)
          app.savePluginOptions(options, function(err, result) {
            if (err) {
              app.debug(err)
            }
          })
        }
      }

      let obj = {}
      keyPaths.forEach(element => {
        obj[element] = true
      })

      shouldStore = function(path) {
        return typeof obj[path] != "undefined"
      }

      var handleDelta = function(delta, options){
        if (delta.updates && delta.context === selfContext) {
          delta.updates.forEach(update => {
            //app.debug('update: ' + util.inspect(update))

            if (
              update.values &&
              typeof update.$source != "undefined" &&
              update.$source != "signalk-polar"
            ) {
              var points = update.values.reduce((acc, pathValue, options) => {
                //app.debug('found ' + pathValue.path)
                if (pathValue.path == "navigation.rateOfTurn") {
                  //var rotTime = new Date(update.timestamp)
                  //rotTimeSeconds = rotTime.getTime() / 1000 //need to convert to seconds for comparison
                  currentRot = pathValue.value
                }
                if (pathValue.path == "navigation.speedThroughWater") {
                  //var stwTime = new Date(update.timestamp)
                  //stwTimeSeconds = stwTime.getTime() / 1000
                  currentStw = pathValue.value
                }
                if (pathValue.path == "environment.wind.angleApparent") {
                  //var awaTime = new Date(update.timestamp)
                  //awaTimeSeconds = awaTime.getTime() / 1000
                  currentAwa = pathValue.value
                }
                if (pathValue.path == "environment.wind.angleTrueGround") {
                  currentTwa = pathValue.value
                  //var twaTime = new Date(update.timestamp)
                  //twaTimeSeconds = twaTime.getTime() / 1000
                }
                if (pathValue.path == "environment.wind.speedApparent") {
                  //var awsTime = new Date(update.timestamp)
                  //awsTimeSeconds = awsTime.getTime() / 1000
                  currentAws = pathValue.value
                }
                if (pathValue.path == "environment.wind.speedTrue") {
                  currentTws = pathValue.value
                  //var twsTime = new Date(update.timestamp)
                  //twsTimeSeconds = twsTime.getTime() / 1000
                }
                if (pathValue.path == "navigation.courseOverGroundTrue") {
                  //var cogTime = new Date(update.timestamp)
                  //cogTimeSeconds = cogTime.getTime() / 1000
                  currentCog = pathValue.value
                }
                if (pathValue.path == "navigation.speedOverGround") {
                  //var sogTime = new Date(update.timestamp)
                  //sogTimeSeconds = sogTime.getTime() / 1000
                  currentSog = pathValue.value
                }
                if (pathValue.path == "performance.velocityMadeGood") {
                  currentVmg = pathValue.value
                  //var vmgTime = new Date(update.timestamp)
                  //vmgTimeSeconds = vmgTime.getTime() / 1000
                }
                /*//calculate if old or non existing
                tws = getTrueWindSpeed(stw, aws, awa)
                twa = getTrueWindAngle(stw, tws, aws, awa)
                vmg = getVelocityMadeGood(stw, twa)
                */
              })
            }
          })
        }
      }

      app.signalk.on("delta", handleDelta)


      var fullActivePolar = {}
      getPolar(activePolar, userDir, plugin).then((full) => {
        fullActivePolar = full
      })


      let pushInterval = setInterval(function() {
        var beatAngle, beatSpeed, gybeAngle, gybeSpeed
        var windIndex = 0 //@TODO search for right one
        var activePolarWindArray = []
        fullActivePolar[activePolar].windData.forEach(item => {
          activePolarWindArray.push(item.trueWindSpeed)
        })

        var windIndex = closest(currentTws, activePolarWindArray)
        //app.debug('currentTws: ' + currentTws + ' windIndex: ' + windIndex)

        if(fullActivePolar[activePolar].windData[windIndex].optimalBeats[0][0]){
          beatAngle = fullActivePolar[activePolar].windData[windIndex].optimalBeats[0][0]
          pushDelta(app, "performance.beatAngle", beatAngle, plugin)
        }
        if(fullActivePolar[activePolar].windData[windIndex].optimalBeats[0][1]){
          beatSpeed = fullActivePolar[activePolar].windData[windIndex].optimalBeats[0][1]
          pushDelta(app, "performance.beatAngleTargetSpeed", beatSpeed, plugin)
        }
        if(fullActivePolar[activePolar].windData[windIndex].optimalGybes[0][0]){
          gybeAngle = fullActivePolar[activePolar].windData[windIndex].optimalGybes[0][0]
          pushDelta(app, "performance.gybeAngle", gybeAngle, plugin)
        }
        if(fullActivePolar[activePolar].windData[windIndex].optimalGybes[0][1]){
          gybeSpeed = fullActivePolar[activePolar].windData[windIndex].optimalGybes[0][1]
          pushDelta(app, "performance.gybeAngleTargetSpeed", gybeSpeed, plugin)
        }

        //app.debug("tws: " + tws + " abs twa: " + Math.abs(twa) + " stw: " + stw)
        //getTarget(app, tws, twsInterval, twa, twaInterval, stw)
        //app.debug("sent to setInterval:" +  tws + " : " + twsInterval + " : " + Math.abs(twa) + " : " + twaInterval)
      }, 1000)
    },

    registerWithRouter: function(router) {

        //@TODO: add put message to delete table

        router.get("/polarTables", async(req, res) => {
          res.contentType("application/json")
          var polarsCombined = {}

          const arr = await Promise.all(
            polarList.map(item => {
              return getPolar(item, userDir, plugin)
            })
          )
          var results =  arr.reduce((a, b) => Object.assign(a, b), {})
          var response = { polars: results }
          res.send(response)
        })

        router.get("/polarTable", async (req, res) => {
          res.contentType("application/json")
          var uuid = req.query.uuid?req.query.uuid:activePolar
          var response =  await getPolar(uuid, userDir, plugin)
          res.send(response)
        })

        router.get("/listPolarTables", (req, res) => {
          res.contentType("application/json")
          app.debug(polarList)
          res.send(polarList)
        })

        router.get("/deletePolarTable", (req, res) =>{
          var uuid = req.query.uuid
          app.debug("requested to delete " + uuid)
          deletePolarTable(uuid)
          res.redirect('back')
        })


    },
    stop: function() {
      //app.signalk.removeListener("delta", handleDelta)
    }
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
    app.debug(
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

function pushDelta(app, path, value, plugin) {
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

function closest(num, arr) {
  var curr = arr[0],
  diff = num - curr,
  index = 0;
  if(num<arr[0]){
    return 0
  } else if (num>arr[arr.length]){
    return arr.length
  } else {
    for (var val = 0; val < arr.length-1; val++) {
      //app.debug(val + ' comparing ' + num + ' to ' + arr[val])
      let newdiff = num - arr[val];
      if (newdiff < diff && newdiff > 0) {
        diff = newdiff;
        curr = arr[val];
        index = val;
      }
    }
    return index;
  }
}

const getPolar = async (uuid, userDir, plugin) => {
  if(typeof(userDir) != 'undefined' && typeof(uuid) != 'undefined'){
    let tableFile = path.join(userDir, 'plugin-config-data', plugin.id, uuid)
    tableFile = tableFile.slice(0, -1) + '.json'
    try {
      if (fs.existsSync(tableFile)) {
        var rawData = await fs.readFileSync(tableFile, function (err, data) {
          if (err) {
            app.debug(err);
            process.exit(1);
          }
        })

        var response = JSON.parse(rawData)
        //app.debug(response)
        return response
      }
    } catch(err) {
      console.error(err)
    }
  }
  else {
    return
  }
}
