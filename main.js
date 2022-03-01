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

var csvList = ["ignore"]//"Set" for unique

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
  var polarList = ["none"]
  var polarNames = ["No active Polar"]
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
  var currentTwaQuadrant
  var unsubscribes = []


  return {
    id: "signalk-polar",
    name: "Polar storage and retrieval",
    description:
    "Signal K server plugin that stores and retrieves static and/or dynamic polar data",
    uiSchema: {
      entered: {
        items: {
          polarUuid: { "ui:widget": "hidden" },
          csvTable: { "ui:widget": "textarea" }
        }
      },
      useDynamicPolar: { "ui:widget": "hidden" },
      engine: { "ui:widget": "hidden" },
      additional_info: { "ui:widget": "hidden" },
      sqliteFile: { "ui:widget": "hidden" },
      angleResolution: { "ui:widget": "hidden" },
      twsInterval: { "ui:widget": "hidden" },
      maxWind: { "ui:widget": "hidden" },
      rateOfTurnLimit: { "ui:widget": "hidden" }
    },
    schema: {
      type: "object",
      title:
      "A Signal K (node) plugin to maintain polar diagrams",
      description: "",
      properties: {
        activePolar: {
          type: "string",
          title: "Active polar table",
          enum: polarList,
          enumNames: polarNames,
          default: "none"
        },
        entered: {
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
        },
        useDynamicPolar: {
          type: "boolean",
          title: "Use dynamic polar diagram (may slow down server). Active polar will be updated"
        },
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

      if (options.activePolar){
        activePolar = options.activePolar
      }

      if (options.updateTables){
        //update tables and JSON files
        if (options.entered && options.entered.length > 0) {
          var counter = 0
          options.entered.forEach(table => {
            var tableName = table.polarName.replace(/ /gi, "_")
            var tableUuid
            if (table.polarUuid) {
              tableUuid = table.polarUuid
              //app.debug("Polar uuid exists: '" + tableUuid + "'", typeof(tableUuid))
            } else {
              tableUuid = uuidv4()
              options.entered[counter].polarUuid = tableUuid
              app.debug("Polar uuid does not exist, creating '" + tableUuid + "'")
              app.savePluginOptions(options, function(err, result) {
                if (err) {
                  app.debug(err)
                }
              })
            }
            polarList.push(table.polarUuid)
            polarNames.push(tableName)
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

              options.entered[counter].csvTable = csvTable

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

      /*
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
*/

else if(options.entered) {
  options.entered.forEach(table => {
    polarList.push(table.polarUuid)
    polarNames.push(table.polarName)
  })
  if (options.entered.length  == 1){
    setActivePolar(options.entered[0].polarUuid)
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
          if (pathValue.path == "environment.wind.angleTrueWater") {
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

          //@TODO add stale logic

          currentTwaQuadrant = calculateQuadrant(currentTwa)

        })
      }
    })
  }
}

app.signalk.on("delta", handleDelta)
unsubscribes.push(() => {
        app.signalk.removeListener('delta', handleDelta);
      });


var fullActivePolar = {}
getPolar(activePolar, userDir, plugin).then((full) => {
  fullActivePolar = full
})


if(activePolar != "none" && activePolar != undefined) {
  console.log("active polar: " + activePolar)
  let pushInterval = setInterval(function() {
    var beatAngle, beatSpeed, gybeAngle, gybeSpeed
    var windIndex = 0 //@TODO search for right one
    var activePolarWindArray = []
    fullActivePolar[activePolar].windData.forEach(item => {
      activePolarWindArray.push(item.trueWindSpeed)
    })

    var windIndex = closest(currentTws, activePolarWindArray)
    //app.debug('currentTws: ' + currentTws + ' windIndex: ' + windIndex)

    //@TODO: if wind angle not more acute than beatAngle or more obtuse than gybeAngles, interpolate between angles for lower and higher windIndex, and between these
    var polarSpeed, polarSpeedRatio
    var windAngleIndex = closestAngle(currentTwa, fullActivePolar[activePolar].windData[windIndex].angleData)
    if(windIndex == 0 || windIndex == activePolarWindArray.length){
      //if lowest or highest wind speed in table, interpolate only for wind angle
      polarSpeed = interpolate(
        currentTwa,
        fullActivePolar[activePolar].windData[windIndex].angleData[windAngleIndex][0],
        fullActivePolar[activePolar].windData[windIndex].angleData[windAngleIndex+1][0],
        fullActivePolar[activePolar].windData[windIndex].angleData[windAngleIndex][1],
        fullActivePolar[activePolar].windData[windIndex].angleData[windAngleIndex+1][1],
      )
      polarSpeedRatio = currentStw/polarSpeed
      pushDelta(app, "performance.polarSpeed", polarSpeed, plugin)
      pushDelta(app, "performance.polarSpeedRatio", polarSpeedRatio, plugin)
    } else {
      var psLow = interpolate(
        currentTwa,
        fullActivePolar[activePolar].windData[windIndex].angleData[windAngleIndex][0],
        fullActivePolar[activePolar].windData[windIndex].angleData[windAngleIndex+1][0],
        fullActivePolar[activePolar].windData[windIndex].angleData[windAngleIndex][1],
        fullActivePolar[activePolar].windData[windIndex].angleData[windAngleIndex+1][1],
      )
      var psHigh = interpolate(
        currentTwa,
        fullActivePolar[activePolar].windData[windIndex+1].angleData[windAngleIndex][0],
        fullActivePolar[activePolar].windData[windIndex+1].angleData[windAngleIndex+1][0],
        fullActivePolar[activePolar].windData[windIndex+1].angleData[windAngleIndex][1],
        fullActivePolar[activePolar].windData[windIndex+1].angleData[windAngleIndex+1][1],
      )
      polarSpeed = interpolate(
        currentTws,
        fullActivePolar[activePolar].windData[windIndex].trueWindSpeed,
        fullActivePolar[activePolar].windData[windIndex+1].trueWindSpeed,
        psLow,
        psHigh
      )
      polarSpeedRatio = currentStw/polarSpeed
      pushDelta(app, "performance.polarSpeed", polarSpeed, plugin)
      pushDelta(app, "performance.polarSpeedRatio", polarSpeedRatio, plugin)
    }
    //console.log("windAngle: " + currentTwa + " betw " + fullActivePolar[activePolar].windData[windIndex].angleData[windAngleIndex][0] + " and " + fullActivePolar[activePolar].windData[windIndex].angleData[windAngleIndex+1][0])

    if(fullActivePolar[activePolar].windData[windIndex].optimalBeats[0][0]){
      if(windIndex == 0 || windIndex == activePolarWindArray.length){
        beatAngle = fullActivePolar[activePolar].windData[windIndex].optimalBeats[0][0]
      } else {
        beatAngle = interpolate(
          currentTws,
          fullActivePolar[activePolar].windData[windIndex].trueWindSpeed,
          fullActivePolar[activePolar].windData[windIndex+1].trueWindSpeed,
          fullActivePolar[activePolar].windData[windIndex].optimalBeats[0][0],
          fullActivePolar[activePolar].windData[windIndex+1].optimalBeats[0][0],
        )
      }
      pushDelta(app, "performance.beatAngle", beatAngle, plugin)
    }
    if(fullActivePolar[activePolar].windData[windIndex].optimalBeats[0][1]){
      if(windIndex == 0 || windIndex == activePolarWindArray.length){
        beatSpeed = fullActivePolar[activePolar].windData[windIndex].optimalBeats[0][1]
      } else {
        beatSpeed = interpolate(
          currentTws,
          fullActivePolar[activePolar].windData[windIndex].trueWindSpeed,
          fullActivePolar[activePolar].windData[windIndex+1].trueWindSpeed,
          beatSpeed = fullActivePolar[activePolar].windData[windIndex].optimalBeats[0][1],
          beatSpeed = fullActivePolar[activePolar].windData[windIndex+1].optimalBeats[0][1]
        )
      }
      pushDelta(app, "performance.beatAngleTargetSpeed", beatSpeed, plugin)
    }
    if(fullActivePolar[activePolar].windData[windIndex].optimalGybes[0][0]){
      if(windIndex == 0 || windIndex == activePolarWindArray.length){
        gybeAngle = fullActivePolar[activePolar].windData[windIndex].optimalGybes[0][0]
      } else {
        gybeAngle = interpolate(
          currentTws,
          fullActivePolar[activePolar].windData[windIndex].trueWindSpeed,
          fullActivePolar[activePolar].windData[windIndex+1].trueWindSpeed,
          gybeAngle = fullActivePolar[activePolar].windData[windIndex].optimalGybes[0][0],
          gybeAngle = fullActivePolar[activePolar].windData[windIndex+1].optimalGybes[0][0]
        )
      }
      pushDelta(app, "performance.gybeAngle", gybeAngle, plugin)
    }
    if(fullActivePolar[activePolar].windData[windIndex].optimalGybes[0][1]){
      if(windIndex == 0 || windIndex == activePolarWindArray.length){
        gybeSpeed = fullActivePolar[activePolar].windData[windIndex].optimalGybes[0][1]
      } else {
        gybeSpeed = interpolate(
          currentTws,
          fullActivePolar[activePolar].windData[windIndex].trueWindSpeed,
          fullActivePolar[activePolar].windData[windIndex+1].trueWindSpeed,
          gybeSpeed = fullActivePolar[activePolar].windData[windIndex].optimalGybes[0][1],
          gybeSpeed = fullActivePolar[activePolar].windData[windIndex+1].optimalGybes[0][1]
        )
      }

      pushDelta(app, "performance.gybeAngleTargetSpeed", gybeSpeed, plugin)
    }

    if(windIndex == 0 || windIndex == activePolarWindArray.length){

    }

    //app.debug("tws: " + tws + " abs twa: " + Math.abs(twa) + " stw: " + stw)
    //getTarget(app, tws, twsInterval, twa, twaInterval, stw)
    //app.debug("sent to setInterval:" +  tws + " : " + twsInterval + " : " + Math.abs(twa) + " : " + twaInterval)
  }, 1000)
}

function setActivePolar(uuid){
  activePolar = uuid
  options.activePolar = activePolar
  app.debug('active Polar: ' + options.activePolar)
  app.savePluginOptions(options, function(err, result) {
    if (err) {
      app.debug(err)
    }
  })
}
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

  router.post("/setActivePolar", (req, res) =>{
    var uuid = req.query.uuid
    app.debug("setting active polar " + uuid)
    //@TODO: Add function
    res.redirect('back')
  })



},
stop: function() {
  unsubscribes.forEach(f => f());
  polarList = polarNames = csvList = []
  app.setPluginStatus('Stopped');
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
    /*app.debug(
    "invalid triangle aws: " +
    apparentWindspeed +
    " tws: " +
    trueWindSpeed +
    " bsp: " +
    speed
  )*/
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

function closestAngle(twa, angleData){
  angleData.sort((a, b) => a[0] - b[0])
  return closest(twa, angleData.map(x => x[0]))
}

function interpolate(x, xbottom, xtop, ybottom, ytop){
  var xdist = xtop - xbottom
  var ydist = ytop - ybottom;
  return (ybottom + (((x-xbottom) / xdist)) * ydist)
}

function calculateQuadrant(twa){
  if(twa < 0){
    twa+=Math.PI*2
  }
  var quad = Math.floor(twa/(Math.PI/2))+1
  return quad
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
