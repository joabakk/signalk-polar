/*
* Copyright 2017 Joachim Bakke
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
var db, json
var pushInterval

var vmg, rot, stw, awa, twa, aws, tws, eng, sog, cog, tack
var engineRunning = true
var engineSKPath = ""
var rateOfTurnLimit
var twsInterval //Wind speed +-x m/s
var twaInterval //Wind angle +-x radians
var stableCourse = false
var trimPolars = false //not implemented, can't see how...

var vmgTimeSeconds = (rotTimeSeconds = stwTimeSeconds = twaTimeSeconds = twsTimeSeconds = vmgTimeSeconds = awaTimeSeconds = awsTimeSeconds = engTimeSeconds = cogTimeSeconds = sogTimeSeconds = 0)
var lastStored = 1
var storeRecord
var secondsSincePush = 100
var mainPolarUuid
var mainPolarIndex, mainPolarData
var polarName
var polarDescription
var twaInterval, windSpeedIndex, windAngleIndex
var twsInterval
var maxWind
var dbFile
var allPolars
var polarArray = []
var stmt

const items = [
  "performance.velocityMadeGood", // if empty, populate from this plugin
  "navigation.rateOfTurn", // if above threshold, vessel is turning and no data is stored
  "navigation.speedThroughWater",
  "environment.wind.angleApparent",
  "environment.wind.speedApparent",
  "navigation.courseOverGroundTrue",
  "navigation.speedOverGround"
]
const maxInterval = 2 //max interval in seconds between updates for all items to avoid updating on stale data

module.exports = function(app, options) {
  "use strict"
  var client
  var selfContext = "vessels." + app.selfId
  var plugin = {}
  plugin.id = "signalk-polar"

  var unsubscribes = []
  var shouldStore = function(path) {
    return true
  }

  function listPolarTables() {
    return new Promise((resolve, reject) => {
      const polarList = db.prepare("select * from tableUuids").all()
      resolve(polarList)
    })
  }

  function getPolarTable(uuid) {
    var windspeed,
    windSpeedArray,
    windangle,
    tableName,
    uuid,
    description,
    response,
    info,
    query
    function getTableInfo(uuid) {
      return new Promise((resolve, reject) => {
        var query = `SELECT * FROM 'tableUuids' WHERE uuid = ?`
        const queryLine = db.prepare(query)
        const table = queryLine.get(uuid)
        mainPolarIndex = polarArray.indexOf(mainPolarUuid)
        resolve(table)
      })
    }
    var getInfo = async uuid => {
      info = await getTableInfo(uuid)
      tableName = info.name
      description = info.description
      response = {
        [uuid]: {
          name: tableName,
          $description: description,
          source: {
            label: plugin.id
          },
          polarData: []
        }
      }
      app.debug(JSON.stringify(response))
      return response
    }
    //response = getInfo()

    function getWindSpeedArray(uuid) {
      return new Promise((resolve, reject) => {
        var query = `SELECT DISTINCT ROUND(environmentWindSpeedTrue+0.01, 2) AS windspeed from '${uuid}' ORDER BY windSpeed ASC`
        //app.debug(query)
        const queryLine = db.prepare(query)
        const tables = queryLine.all()

        var windSpeeds = []
        tables.forEach(speed => {
          windSpeeds.push(speed.windspeed)
        })
        //app.debug(windSpeeds)
        resolve(windSpeeds)
      })
    }

    function getWindAngleArray(uuid, wsp, wspLow) {
      return new Promise((resolve, reject) => {
        var query = `SELECT environmentWindAngleTrueGround AS angles from '${uuid}' WHERE environmentWindSpeedTrue < ${wsp} AND environmentWindSpeedTrue > ${wspLow} ORDER BY angles ASC`
        //app.debug(query)
        const queryLine = db.prepare(query)
        const tables = queryLine.all()
        var windAngles = []
        tables.forEach(angle => {
          windAngles.push(angle.angles)
        })
        //app.debug(windAngles)
        resolve(windAngles)
      })
    }

    function getPerf(uuid, wsp, wspLow) {
      var perfPromises = []
      query =
      `SELECT environmentWindAngleTrueGround, navigationSpeedThroughWater FROM '` +
      uuid +
      `' WHERE environmentWindSpeedTrue < ` +
      wsp +
      ` AND  environmentWindSpeedTrue > ` +
      wspLow +
      ` AND environmentWindAngleTrueGround < ` +
      Math.PI +
      ` AND environmentWindAngleTrueGround > 0 ORDER BY performanceVelocityMadeGood DESC LIMIT 1`
      //app.debug(query)
      perfPromises.push(db.prepare(query).get())
      query =
      `SELECT environmentWindAngleTrueGround, navigationSpeedThroughWater FROM '` +
      uuid +
      `' WHERE environmentWindSpeedTrue < ` +
      wsp +
      ` AND  environmentWindSpeedTrue > ` +
      wspLow +
      ` AND environmentWindAngleTrueGround < 0 AND environmentWindAngleTrueGround > ` +
      -Math.PI +
      ` ORDER BY performanceVelocityMadeGood DESC LIMIT 1`
      perfPromises.push(db.prepare(query).get())
      query =
      `SELECT environmentWindAngleTrueGround, navigationSpeedThroughWater FROM '` +
      uuid +
      `' WHERE environmentWindSpeedTrue < ` +
      wsp +
      ` AND  environmentWindSpeedTrue > ` +
      wspLow +
      ` AND environmentWindAngleTrueGround < ` +
      Math.PI +
      ` AND environmentWindAngleTrueGround > 0 ORDER BY performanceVelocityMadeGood ASC LIMIT 1`
      perfPromises.push(db.prepare(query).get())
      query =
      `SELECT environmentWindAngleTrueGround, navigationSpeedThroughWater FROM '` +
      uuid +
      `' WHERE environmentWindSpeedTrue < ` +
      wsp +
      ` AND  environmentWindSpeedTrue > ` +
      wspLow +
      ` AND environmentWindAngleTrueGround < 0 AND environmentWindAngleTrueGround > ` +
      -Math.PI +
      ` ORDER BY performanceVelocityMadeGood ASC LIMIT 1`
      perfPromises.push(db.prepare(query).get())
      var p = Promise.all(perfPromises).catch(error =>
        console.log(`Error in getPerf: ${error}`)
      )
      return p
    }

    var polarData
    const speedLoop = async uuid => {
      response = await getInfo(uuid)
      var windSpeedArray
      if (uuid == mainPolarUuid) {
        windSpeedArray = []
        for (var windspeed = twsInterval;windspeed < maxWind;windspeed += twsInterval) {
          windSpeedArray.push(windspeed)
        }
      } else {
        windSpeedArray = await getWindSpeedArray(uuid)
      }

      let windPromises = []
      windSpeedArray.forEach(function(element, index, array) {
        let wsp = element
        var wspLow
        index >= 1 ? (wspLow = array[index - 1]) : (wspLow = 0)
        polarData = []

        const angleLoop = async wsp => {
          let anglePromises = []
          var data = await getPerf(uuid, wsp, wspLow).then(values => {
            var data = {
              trueWindSpeed: wsp,
              beatAngles: [],
              beatSpeeds: [],
              gybeAngles: [],
              gybeSpeeds: [],
              trueWindAngles: [],
              polarSpeeds: [],
              velocitiesMadeGood: []
            }
            //app.debug(JSON.stringify(values))
            if (
              values[0] !== null &&
              values[0] != "null" &&
              values[0] !== undefined &&
              values[0] != "undefined"
            ) {
              var value = JSON.parse(JSON.stringify(values[0]))
              data.beatAngles.push(value.environmentWindAngleTrueGround)
              data.beatSpeeds.push(value.navigationSpeedThroughWater)
            }
            if (
              values[1] !== null &&
              values[1] != "null" &&
              values[1] !== undefined &&
              values[1] != "undefined"
            ) {
              var value = JSON.parse(JSON.stringify(values[1]))
              data.beatAngles.push(value.environmentWindAngleTrueGround)
              data.beatSpeeds.push(value.navigationSpeedThroughWater)
            }
            if (
              values[2] !== null &&
              values[2] != "null" &&
              values[2] !== undefined &&
              values[2] != "undefined"
            ) {
              var value = JSON.parse(JSON.stringify(values[2]))
              data.gybeAngles.push(value.environmentWindAngleTrueGround)
              data.gybeSpeeds.push(value.navigationSpeedThroughWater)
            }
            if (
              values[3] !== null &&
              values[3] != "null" &&
              values[3] !== undefined &&
              values[3] != "undefined"
            ) {
              var value = JSON.parse(JSON.stringify(values[3]))
              data.gybeAngles.push(value.environmentWindAngleTrueGround)
              data.gybeSpeeds.push(value.navigationSpeedThroughWater)
            }
            //app.debug("getPerfAsync: ", JSON.stringify(data))
            return data
          })
          var windAngleArray = []

          if (uuid == mainPolarUuid) {
            //If at the dynamic polar, we still want to produce polars with angles to set interval
            for (var angle = -Math.PI; angle < Math.PI; angle += twaInterval) {
              //app.debug(wsp + " m/s, angle: " + angle)
              windAngleArray.push(angle)
            }
          } else {
            var windAngleArray = await getWindAngleArray(uuid, wsp, wspLow)
          }

          windAngleArray.forEach(function(angle, index, array) {
            data.trueWindAngles.push(angle)
            var angleHigh = angle + twaInterval * 0.5
            var angleLow = angle - twaInterval * 0.5
            //wspLow = wsp - twsInterval
            var query =
            `SELECT performanceVelocityMadeGood AS vmg, navigationSpeedThroughWater AS speed FROM '` +
            uuid +
            `' WHERE environmentWindSpeedTrue < ` +
            wsp +
            ` AND  environmentWindSpeedTrue > ` +
            wspLow +
            ` AND environmentWindAngleTrueGround < ` +
            angleHigh +
            ` AND environmentWindAngleTrueGround > ` +
            angleLow +
            ` ORDER BY navigationSpeedThroughWater DESC`
            //app.debug(query)
            anglePromises.push(db.prepare(query).get())
            //}
          })
          //app.debug(util.inspect(anglePromises))
          const results = await Promise.all(anglePromises)

          //app.debug(JSON.stringify(results))
          results.forEach(angleFunction)

          function angleFunction(result, index) {
            if (result != undefined) {
              result.speed
              ? data.polarSpeeds.push(result.speed)
              : data.polarSpeeds.push(null)
              result.vmg
              ? data.velocitiesMadeGood.push(result.vmg)
              : data.velocitiesMadeGood.push(null)
            } else {
              data.polarSpeeds.push(null)
              data.velocitiesMadeGood.push(null)
            }
          }
          polarData = data
          return polarData
        }
        windPromises.push(angleLoop(wsp))
      })

      const windResults = await Promise.all(windPromises)
      //app.debug("windPromises: " + JSON.stringify(windResults))
      windResults.forEach(windFunction)
      function windFunction(polarData, index) {
        //app.debug(JSON.stringify(response))
        response[uuid].polarData.push(polarData)
      }
      function countNonEmpty(array) {
        return array.filter(Boolean).length
      }
      function trimPolar() {
        var trimmedPolar = []
        response[uuid].polarData.forEach(data => {
          var arraysToCheck = [
            data.beatAngles,
            data.gybeAngles,
            data.beatSpeeds,
            data.gybeSpeeds,
            data.polarSpeeds,
            data.velocitiesMadeGood
          ]
          var arrayNum = 6
          arraysToCheck.forEach(x => {
            if (countNonEmpty(x) <= 0) {
              arrayNum -= 1
            }
          })
          if (arrayNum != 0) {
            trimmedPolar.push(data)
          }
        })
        app.debug("trim polar finished")
        return trimmedPolar
      }
      if (false) {
        //Not implemented, would mess with dynamic comparisons
        var trimmedPolar = trimPolar()
        response[uuid].polarData = trimmedPolar
      }
      return response
    }
    return new Promise((resolve, reject) => {
      var res = speedLoop(uuid)
      resolve(res)
    })
  }

  function handleDelta(delta, options) {
    if (delta.updates && delta.context === selfContext) {
      delta.updates.forEach(update => {
        if (
          update.values &&
          typeof update.source != "undefined" &&
          update.source.talker != "signalk-polar"
        ) {
          var points = update.values.reduce((acc, pathValue, options) => {
            if (typeof pathValue.value === "number" && engineSKPath != "doNotStore") {
              //propulsion.*.state is not number!
              var storeIt = shouldStore(pathValue.path)

              if (storeIt) {
                app.debug(update.timestamp + " " + pathValue.path + " " + pathValue.value)
                if (pathValue.path == "navigation.rateOfTurn") {
                  var rotTime = new Date(update.timestamp)
                  rotTimeSeconds = rotTime.getTime() / 1000 //need to convert to seconds for comparison
                  rot = pathValue.value
                }
                if (pathValue.path == "navigation.speedThroughWater") {
                  var stwTime = new Date(update.timestamp)
                  stwTimeSeconds = stwTime.getTime() / 1000
                  stw = pathValue.value
                }
                if (pathValue.path == "environment.wind.angleApparent") {
                  var awaTime = new Date(update.timestamp)
                  awaTimeSeconds = awaTime.getTime() / 1000
                  awa = pathValue.value
                }
                if (pathValue.path == "environment.wind.angleTrueGround") {
                  twa = pathValue.value
                  var twaTime = new Date(update.timestamp)
                  twaTimeSeconds = twaTime.getTime() / 1000
                }
                if (pathValue.path == "environment.wind.speedApparent") {
                  var awsTime = new Date(update.timestamp)
                  awsTimeSeconds = awsTime.getTime() / 1000
                  aws = pathValue.value
                }
                if (pathValue.path == "environment.wind.speedTrue") {
                  tws = pathValue.value
                  var twsTime = new Date(update.timestamp)
                  twsTimeSeconds = twsTime.getTime() / 1000
                }
                if (pathValue.path == "navigation.courseOverGroundTrue") {
                  var cogTime = new Date(update.timestamp)
                  cogTimeSeconds = cogTime.getTime() / 1000
                  cog = pathValue.value
                }
                if (pathValue.path == "navigation.speedOverGround") {
                  var sogTime = new Date(update.timestamp)
                  sogTimeSeconds = sogTime.getTime() / 1000
                  sog = pathValue.value
                }
                if (pathValue.path == "performance.velocityMadeGood") {
                  vmg = pathValue.value
                  var vmgTime = new Date(update.timestamp)
                  vmgTimeSeconds = vmgTime.getTime() / 1000
                }
                var engTime
                if (
                  engineSKPath != "AlwaysOff" &&
                  engineSKPath != "doNotStore"
                ) {
                  if (pathValue.path == engineSKPath) {
                    engTime = new Date(update.timestamp)
                    engTimeSeconds = engTime.getTime() / 1000
                    eng = pathValue.value
                  }
                } else {
                  engTime = new Date(update.timestamp) //take the last timestamp
                  engTimeSeconds = engTime.getTime() / 1000
                }

                //app.debug("times: " /*+ rotTimeSeconds + " "*/ + stwTimeSeconds + " " + awaTimeSeconds + " " + engTimeSeconds)
                //app.debug("rot: " +rot + " stw: " + stw + " awa: " + awa+ " eng: " + eng)
                var timeMax = Math.max(
                  /*rotTimeSeconds,*/ stwTimeSeconds,
                  awaTimeSeconds,
                  awsTimeSeconds,
                  cogTimeSeconds
                )
                var timeMin = Math.min(
                  /*rotTimeSeconds,*/ stwTimeSeconds,
                  awaTimeSeconds,
                  awsTimeSeconds,
                  cogTimeSeconds
                )
                var timediff = timeMax - timeMin //check that values are fairly concurrent
                //app.debug("time diff " + timediff)

                if (engineSKPath.indexOf(".state") > -1 &&(eng != "[object Object]" && eng == "started")) {
                  engineRunning = true
                } else if (engineSKPath.indexOf(".revolutions") > -1 && eng >= 1) {
                  //RPM
                  engineRunning = true
                } else if (engineSKPath == "doNotStore") {
                  engineRunning = true
                } else {
                  engineRunning = false
                }
                //app.debug("engine running? " + engineRunning)
                if (Math.abs(rot * 3437) < rateOfTurnLimit) {
                  stableCourse = true
                } else {
                  stableCourse = false
                }
                //app.debug("stable course? " + stableCourse +" "+ Math.abs(rot*3437) + " deg/min compared to " + rateOfTurnLimit)

                app.debug("timediff " + timediff + " , engine running? " + engineRunning + " stable? " + stableCourse + " last store " +   lastStored)
                if (timediff < maxInterval && !engineRunning && stableCourse && lastStored < timeMax - 1) {
                  app.debug("sailing")
                  if (timeMax - twsTimeSeconds > 1) {
                    //app.debug("finding tws")
                    tws = getTrueWindSpeed(stw, aws, awa)
                    //twsTimeSeconds = new Date()/ 1000
                  }
                  if (timeMax - twaTimeSeconds > 1) {
                    //app.debug("finding twa")
                    twa = getTrueWindAngle(stw, tws, aws, awa)
                    //twaTimeSeconds = new Date()/ 1000
                  }
                  if (timeMax - vmgTimeSeconds > 1) {
                    //app.debug("finding vmg of " + stw + " and " + twa)
                    vmg = getVelocityMadeGood(stw, twa)
                    //vmgTimeSeconds = new Date()/ 1000
                  }
                  //app.debug(secondsSincePush, timeMax)
                  if (secondsSincePush < timeMax - 1) {
                    //app.debug("time to push")
                    pushDelta(app, {
                      key: "environment.wind.speedTrue",
                      value: tws
                    })
                    pushDelta(app, {
                      key: "environment.wind.angleTrueWater",
                      value: twa
                    })
                    pushDelta(app, {
                      key: "performance.velocityMadeGood",
                      value: vmg
                    })
                    secondsSincePush = timeMax
                  }
                  //tack is implicit in wind angle, no need to check (or store)
                  windSpeedIndex = Math.ceil(tws / twsInterval) - 1
                  //app.debug(windSpeedIndex + " as index for tws: " + tws)
                  windAngleIndex = Math.round((Math.PI + twa) / twaInterval)
                  //app.debug(windAngleIndex + " as index for twa: " + twa)
                  var storedSpeed = mainPolarData[windSpeedIndex].polarSpeeds[windAngleIndex]
                  app.debug(typeof(storedSpeed), storedSpeed + " as stored speed")
                  if (storedSpeed === null) {
                    app.debug("nothing stored, should store")
                    storeRecord = true
                  } else if (storedSpeed < stw) {
                    app.debug("stored " + storedSpeed + " > actual " + stw + " , storing!")
                    storeRecord = true
                  } else {
                    app.debug("stored " + storedSpeed + " < actual " + stw + " , nothing to do here!")
                    storeRecord = false
                  }

                  var timeMaxIso = new Date(timeMax * 1000).toISOString()
                  twa < 0 ? (tack = "starboard") : (tack = "port")
                  if (storeRecord == true) {
                    stmt = db.prepare(
                      `INSERT INTO '${mainPolarUuid}'(timestamp, environmentWindSpeedApparent, environmentWindSpeedTrue, environmentWindAngleApparent, environmentWindAngleTrueGround, navigationSpeedThroughWater, performanceVelocityMadeGood, tack)VALUES ('${timeMaxIso}', ${aws}, ${tws}, ${awa}, ${twa}, ${stw}, ${vmg}, '${tack}' )`
                    )
                    var info = stmt.run()
                    app.debug(info.changes + " changes to db")
                    mainPolarData[windSpeedIndex].polarSpeeds[windAngleIndex] = stw
                    mainPolarData[windSpeedIndex].velocitiesMadeGood[windAngleIndex] = vmg
                    storeRecord = false
                  }
                }
              }
            }
            return acc
          }, [])
        }
      })
    }
  }

  return {
    id: "signalk-polar",
    name: "Polar storage and retrieval",
    description:
    "Signal K server plugin that stores and retrieves polar data from sqlite3 database",
    uiSchema: {
      mainPolarUuid: { "ui:widget": "hidden" },
      entered: {
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
          title: "File for storing sqlite3 data, relative path to server",
          default: "./polarDatabase.db"
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
          "Store in database if rate of turn is less than [ ] deg/min (inertia gives false reading while turning vessel)",
          default: 5
        },
        entered: {
          type: "array",
          title: "User input polars",
          items: {
            title: " ",
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
              csvTable: {
                type: "string",
                title:
                "enter csv with polar in http://jieter.github.io/orc-data/site/ style"
              }
            }
          }
        }
      }
    },
    start: function(options) {
      dbFile = options.sqliteFile
      twaInterval = options.angleResolution * Math.PI / 180
      twsInterval = options.twsInterval
      secondsSincePush = 10
      app.debug("twsInterval: " + twsInterval)
      polarDescription = options.polarDescription
      maxWind = options.maxWind
      if (options.mainPolarUuid) {
        mainPolarUuid = options.mainPolarUuid
        app.debug("Polar uuid exists: " + mainPolarUuid, typeof mainPolarUuid)
      } else {
        mainPolarUuid = uuidv4()
        options.mainPolarUuid = mainPolarUuid
        app.debug("Polar uuid does not exist, creating " + mainPolarUuid)
        app.savePluginOptions(options, function(err, result) {
          if (err) {
            console.log(err)
          }
        })
      }
      db = new Database(options.sqliteFile, { timeout: 10000 })
      polarName = options.polarName.replace(/ /gi, "_")
      app.debug("polar name is " + polarName)
      var create
      create = db
      .prepare(
        `CREATE TABLE IF NOT EXISTS tableUuids (uuid TEXT UNIQUE NOT NULL, name TEXT, description TEXT)`
      )
      .run()
      create = db
      .prepare(
        `CREATE TABLE IF NOT EXISTS '${mainPolarUuid}' (timestamp TEXT,  environmentWindSpeedApparent DOUBLE DEFAULT NULL, environmentWindSpeedTrue DOUBLE DEFAULT NULL,  environmentWindAngleApparent DOUBLE DEFAULT NULL,  environmentWindAngleTrueGround DOUBLE DEFAULT NULL,  navigationSpeedThroughWater DOUBLE DEFAULT NULL, performanceVelocityMadeGood DOUBLE DEFAULT NULL, tack TEXT,  navigationRateOfTurn DOUBLE DEFAULT NULL)`
      )
      .run()
      db
      .prepare(
        "INSERT OR REPLACE INTO tableUuids (`uuid`, `name`, `description`) VALUES( ?,?,?)"
      )
      .run([mainPolarUuid, polarName, polarDescription])
      db
      .prepare(
        `CREATE INDEX IF NOT EXISTS main_wst ON '${mainPolarUuid}' (environmentWindSpeedTrue)`
      )
      .run()
      db
      .prepare(
        `CREATE INDEX IF NOT EXISTS main_watg ON '${mainPolarUuid}' (environmentWindAngleTrueGround)`
      )
      .run()

      if (options.entered && options.entered.length > 0) {
        options.entered.forEach(table => {
          var tableName = table.polarName.replace(/ /gi, "_")
          var tableUuid
          if (table.polarUuid) {
            tableUuid = table.polarUuid
            //app.debug("Polar uuid exists: '" + tableUuid + "'", typeof(tableUuid))
          } else {
            tableUuid = uuidv4()
            table.polarUuid = tableUuid
            //app.debug("Polar uuid does not exist, creating '" + tableUuid + "'")
            app.savePluginOptions(options, function(err, result) {
              if (err) {
                console.log(err)
              }
            })
          }
          app.debug("polar name is " + tableName)
          create = db.prepare(`DROP TABLE IF EXISTS '${tableUuid}'`).run()
          db
          .prepare(
            `CREATE TABLE IF NOT EXISTS '${tableUuid}' (environmentWindSpeedTrue DOUBLE DEFAULT NULL, environmentWindAngleTrueGround DOUBLE DEFAULT NULL, navigationSpeedThroughWater DOUBLE DEFAULT NULL, performanceVelocityMadeGood DOUBLE DEFAULT NULL)`
          )
          .run()
          db
          .prepare(
            "INSERT OR REPLACE INTO tableUuids (`uuid`, `name`, `description`) VALUES( ?,?,?)"
          )
          .run([tableUuid, tableName, table.description])
          db
          .prepare(
            `CREATE INDEX IF NOT EXISTS ${tableName}_wst ON '${tableUuid}' (environmentWindSpeedTrue)`
          )
          .run()
          db
          .prepare(
            `CREATE INDEX IF NOT EXISTS ${tableName}_watg ON '${tableUuid}' (environmentWindAngleTrueGround)`
          )
          .run()

          var output = []

          parse(table.csvTable, {
            trim: true,
            skip_empty_lines: true,
            delimiter: ";"
          }).on("readable", function() {
            let record
            while ((record = this.read())) {
              output.push(record)
            }
            //app.debug(JSON.stringify(output))
            var windSpeeds = []
            output[0].forEach(listSpeeds)
            function listSpeeds(item, index) {
              if (index > 0) {
                //first is "twa/tws"
                //var windSpeedItem = item//@TODO: remove and replace with below
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
                  //var speed = Number(speedItem)//@TODO: replace with below
                  var speed = utilSK.transform(speedItem,table.boatSpeedUnit,  "ms"  )
                  if (index > 0 && speedItem > 0) {
                    //first item is angle, already parsed
                    var vmg = getVelocityMadeGood(speed, itemAngle)
                    //app.debug(`INSERT INTO '${tableUuid} '(environmentWindSpeedTrue, environmentWindAngleTrueGround, navigationSpeedThroughWater, performanceVelocityMadeGood ) VALUES (${windSpeeds[index-1]}, ${itemAngle}, ${speed}, ${vmg})`)
                    db.prepare(
                      `INSERT INTO '${tableUuid}'(environmentWindSpeedTrue, environmentWindAngleTrueGround, navigationSpeedThroughWater, performanceVelocityMadeGood ) VALUES (${
                        windSpeeds[index - 1]
                      }, 0, 0, 0)`
                    )
                    .run()
                    db.prepare(
                      `INSERT INTO '${tableUuid}'(environmentWindSpeedTrue, environmentWindAngleTrueGround, navigationSpeedThroughWater, performanceVelocityMadeGood ) VALUES (${
                        windSpeeds[index - 1]
                      }, ${itemAngle}, ${speed}, ${vmg})`
                    )
                    .run()
                    if(table.mirror){
                      db.prepare(
                        `INSERT INTO '${tableUuid}'(environmentWindSpeedTrue, environmentWindAngleTrueGround, navigationSpeedThroughWater, performanceVelocityMadeGood ) VALUES (${
                          windSpeeds[index - 1]
                        }, ${-itemAngle}, ${speed}, ${vmg})`
                      )
                      .run()
                    }
                    //app.debug("windspeed: " + windSpeeds[index-1] + " angle: " + itemAngle + " boatspeed: " + speed)
                  }
                }
              }
            }
          })
        })
      }
      const getMainPolar = async () => {
        var mainpolardata = await getPolarTable(mainPolarUuid)
        return mainpolardata
      }
      async function mainPolarFunc() {
        const response = await getMainPolar()
        //app.debug(Object.values(response)[0].polarData)
        mainPolarData = Object.values(response)[0].polarData
      }
      mainPolarFunc()

      const getAllPolars = async () => {
        const polarList = await listPolarTables()
        const results = await Promise.all(
          polarList.map(item => {
            polarArray.push(item.uuid)
            return getPolarTable(item.uuid)
          })
        )
        var polars = {
          polars: results
        }
        return results
      }
      async function allPolarFunc() {
        const response = await getAllPolars()
        app.debug(response)
        allPolars = response
      }
      allPolarFunc()

      pushInterval = setInterval(function() {
        //app.debug("tws: " + tws + " abs twa: " + Math.abs(twa) + " stw: " + stw)
        getTarget(app, tws, twsInterval, twa, twaInterval, stw)
        //app.debug("sent to setInterval:" +  tws + " : " + twsInterval + " : " + Math.abs(twa) + " : " + twaInterval)
      }, 1000)

      app.debug("started")

      var obj = {}
      if (options.engine == "propulsion.*.revolutions") {
        items.push(options.engine.replace(/\*/g, options.additional_info))
        engineSKPath = options.engine.replace(/\*/g, options.additional_info)
      } else if (options.engine == "propulsion.*.state") {
        items.push(options.engine.replace(/\*/g, options.additional_info))
        engineSKPath = options.engine.replace(/\*/g, options.additional_info)
      } else if (options.engine == "alwaysOff") {
        engineSKPath = "alwaysOff"
      } else if (options.engine == "doNotStore") {
        engineSKPath = "doNotStore"
      }
      rateOfTurnLimit = options.rateOfTurnLimit
      //app.debug("listening for " + util.inspect(items))
      //app.debug("engineSKPath: " + engineSKPath)
      items.forEach(element => {
        obj[element] = true
      })

      shouldStore = function(path) {
        return typeof obj[path] != "undefined"
      }

      app.signalk.on("delta", handleDelta)
    },
    registerWithRouter: function(router) {
      //@TODO: add put message to delete table

      router.get("/polarTables", (req, res) => {
        res.contentType("application/json")
        var response = { polars: allPolars }
        res.send(response)
      })

      router.get("/polarTable", (req, res) => {
        res.contentType("application/json")
        var uuid = req.query.uuid
        var index = polarArray.indexOf(uuid)
        var response = allPolars[index]
        console.log(response)
        res.send(response)
      })

      router.get("/listPolarTables", (req, res) => {
        res.contentType("application/json")
        var response = listPolarTables()
        res.send(response)
      })

    },
    stop: function() {
      app.debug("Stopping")
      unsubscribes.forEach(f => f())
      items.length = items.length - 1
      engineSKPath = ""

      //db.close()
      clearInterval(pushInterval)

      app.signalk.removeListener("delta", handleDelta)
      app.debug("Stopped")
    }
  }

  function getTarget(app, trueWindSpeed, windInterval, trueWindAngle, twaInterval, speedThroughWater)
  {
    //app.debug("getTarget called")
    //if no numbers, return NULL
    if (
      trueWindSpeed !== undefined &&
      windInterval !== undefined &&
      trueWindAngle !== undefined &&
      twaInterval !== undefined &&
      speedThroughWater !== undefined
    ) {
      var windSpeedIndex = Math.ceil(trueWindSpeed / twsInterval) - 1
      var windAngleIndex = Math.round((Math.PI + trueWindAngle) / twaInterval)
      var perfData = mainPolarData[windSpeedIndex]
      var perfIndex
      if (perfData && perfData.beatAngles){

        if (perfData.beatAngles.length == 0) {
          perfData.beatAngles.push(trueWindAngle)
          perfData.beatSpeeds.push(speedThroughWater)
          perfIndex = 0
        } else if (perfData.beatAngles.length == 1) {
          if (
            perfData.beatAngles[0] &&
            Math.sign(trueWindAngle) != Math.sign(perfData.beatAngles[0])
          ) {
            perfData.beatAngles.push(trueWindAngle)
            perfData.beatSpeeds.push(speedThroughWater)
            perfIndex = 1
          } else {
            perfIndex = 0
          }
        } else {
          if (
            perfData.beatAngles[0] &&
            Math.sign(trueWindAngle) != Math.sign(perfData.beatAngles[0])
          ) {
            perfIndex = 1
          } else {
            perfIndex = 0
          }
          var storedVmg = getVelocityMadeGood(
            perfData.beatSpeeds[perfIndex],
            perfData.beatAngles[perfIndex]
          )
          var actualVmg = getVelocityMadeGood(trueWindAngle, speedThroughWater)
          if (actualVmg > storedVmg) {
            perfData.beatAngles[perfIndex] = trueWindAngle
            perfData.beatSpeeds[perfIndex] = speedThroughWater
          }
        }
        if (perfData.gybeAngles.length == 0) {
          perfData.gybeAngles.push(trueWindAngle)
          perfData.gybeSpeeds.push(speedThroughWater)
        } else if (perfData.gybeAngles.length == 1) {
          if (Math.sign(trueWindAngle) != Math.sign(perfData.gybeAngles[0])) {
            perfData.gybeAngles.push(trueWindAngle)
            perfData.gybeSpeeds.push(speedThroughWater)
          }
        } else {
          Math.sign(trueWindAngle) != Math.sign(perfData.gybeAngles[0])
          ? (perfIndex = 1)
          : (perfIndex = 0)
          var storedVmg = getVelocityMadeGood(
            perfData.gybeSpeeds[perfIndex],
            perfData.gybeAngles[perfIndex]
          )
          var actualVmg = getVelocityMadeGood(trueWindAngle, speedThroughWater)
          if (actualVmg < storedVmg) {
            perfData.gybeAngles[perfIndex] = trueWindAngle
            perfData.gybeSpeeds[perfIndex] = speedThroughWater
          }
        }
        var beatangle = perfData.beatAngles[perfIndex]
        pushDelta(app, {
          key: "performance.beatAngle",
          value: beatangle
        })
        pushDelta(app, {
          key: "performance.beatAngleTargetSpeed",
          value: perfData.beatSpeeds[perfIndex]
        })
        pushDelta(app, {
          key: "performance.beatAngleVelocityMadeGood",
          value: Math.max(actualVmg, storedVmg)
        })
        if (Math.abs(trueWindAngle) < Math.PI / 2) {
          pushDelta(app, {
            key: "performance.targetAngle",
            value: perfData.beatAngles[perfIndex]
          })
          pushDelta(app, {
            key: "performance.targetSpeed",
            value: perfData.beatSpeeds[perfIndex]
          })
        }
        pushDelta(app, {
          key: "performance.gybeAngle",
          value: perfData.gybeAngles[perfIndex]
        })
        pushDelta(app, {
          key: "performance.gybeAngleTargetSpeed",
          value: perfData.gybeSpeeds[perfIndex]
        })
        pushDelta(app, {
          key: "performance.gybeAngleVelocityMadeGood",
          value: Math.min(actualVmg, storedVmg)
        })
        if (Math.abs(trueWindAngle) > Math.PI / 2) {
          pushDelta(app, {
            key: "performance.targetAngle",
            value: perfData.gybeAngles[perfIndex]
          })
          pushDelta(app, {
            key: "performance.targetSpeed",
            value: perfData.gybeSpeeds[perfIndex]
          })
        }
        pushDelta(app, {
          key: "performance.polarSpeed",
          value: perfData.polarSpeeds[windAngleIndex]
        })
        pushDelta(app, {
          key: "performance.polarSpeedRatio",
          value: speedThroughWater / perfData.polarSpeeds[windAngleIndex]
        })
      }
      else {
        return
      }
    }
    else {
      return
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

function pushDelta(app, command_json) {
  //app.debug("delta to push: " + JSON.stringify(command_json))
  var key = command_json["key"]
  var value = command_json["value"]
  const data = {
    context: "vessels." + app.selfId,
    updates: [
      {
        source: {
          type: "server",
          sentence: "none",
          label: "calculated",
          talker: "signalk-polar"
        },
        timestamp: utilSK.timestamp(),
        values: [
          {
            path: key,
            value: value
          }
        ]
      }
    ]
  }
  app.signalk.addDelta(data)
  //app.debug("sent data: " + JSON.stringify(data))
  return
}
