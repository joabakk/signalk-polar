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


const Bacon = require('baconjs');
const util = require('util');
const utilSK = require('@signalk/nmea0183-utilities');
const express = require("express");
const _ = require('lodash');
const Database = require('better-sqlite3');
const uuidv4 = require('uuid/v4')
const parse = require('csv-parse')
var db,json;
var pushInterval;

var vmg, rot, stw, awa, twa, aws, tws, eng, sog, cog, tack;
var engineRunning = true;
var engineSKPath = "";
var rateOfTurnLimit
// var twsInterval = 0.1 ;//Wind speed +-0.1 m/s
//var twaInterval = 0.0174533 ;//Wind angle +-1 degree
var stableCourse = false;

var vmgTimeSeconds = rotTimeSeconds = stwTimeSeconds = twaTimeSeconds = twsTimeSeconds = vmgTimeSeconds = awaTimeSeconds = awsTimeSeconds = engTimeSeconds = cogTimeSeconds = sogTimeSeconds = 0
var lastStored = 1
var secondsSincePush
var mainPolarUuid
var polarName
var polarDescription
var twaInterval
var twsInterval
var maxWind
var dbFile
var allPolars
var stmt


const items = [
  "performance.velocityMadeGood", // if empty, populate from this plugin
  "navigation.rateOfTurn", // if above threshold, vessel is turning and no data is stored
  "navigation.speedThroughWater",
  "environment.wind.angleApparent",
  "environment.wind.speedApparent",
  "navigation.courseOverGroundTrue",
  "navigation.speedOverGround"
];
const maxInterval = 2 ;//max interval between updates for all items to avoid updating on stale data

module.exports = function(app, options) {
  'use strict';
  var client;
  var selfContext = "vessels." + app.selfId;
  var plugin = {}
  plugin.id = "signalk-polar"

  var unsubscribes = [];
  var shouldStore = function(path) { return true; };

  async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
      await callback(array[index], index, array);
    }
  }

  function listPolarTables() {
    return new Promise((resolve, reject) => {
      const polarList = db.prepare("select * from tableUuids").all()
      resolve(polarList)
    })
  }

  function getPolarTable(uuid){
    var windspeed, windSpeedArray, windangle, tableName, uuid, description, response, info, query
    function getTableInfo(uuid){
      return new Promise((resolve, reject) => {
        var query = `SELECT * FROM 'tableUuids' WHERE uuid = ?`
        const queryLine = db.prepare(query)
        const table = queryLine.get(uuid)
        resolve(table)

      })
    }
    var getInfo = async(uuid) =>{
      info = await getTableInfo(uuid)
      tableName = info.name
      description = info.description
      response = {
        [uuid]: {
          "name": tableName,
          "$description": description,
          "source": {
            "label": plugin.id
          },
          "polarData": []
        }
      }
      app.debug(JSON.stringify(response))
      return response
    }
    //response = getInfo()

    function getWindSpeedArray(uuid){
      return new Promise((resolve, reject) => {
        var query = `SELECT DISTINCT ROUND(environmentWindSpeedTrue+0.01, 2) AS windspeed from '${uuid}' ORDER BY windSpeed ASC`
        //app.debug(query)
        const queryLine = db.prepare(query)
        const tables = queryLine.all()

        var windSpeeds = []
        tables.forEach(speed =>{
          windSpeeds.push(speed.windspeed)
        })
        //app.debug(windSpeeds)
        resolve(windSpeeds)
      })
    }

    function getWindAngleArray(uuid, wsp, wspLow){
      return new Promise((resolve, reject) =>{
        var query = `SELECT environmentWindAngleTrueGround AS angles from '${uuid}' WHERE environmentWindSpeedTrue < ${wsp} AND environmentWindSpeedTrue > ${wspLow} ORDER BY angles ASC`
        //app.debug(query)
        const queryLine = db.prepare(query)
        const tables = queryLine.all()
        var windAngles = []
        tables.forEach(angle =>{
          windAngles.push(angle.angles)
        })
        //app.debug(windAngles)
        resolve(windAngles)
      })
    }

    function getPerf(uuid, wsp, wspLow){
      var perfPromises = []
      query = `SELECT environmentWindAngleTrueGround, navigationSpeedThroughWater FROM '`+uuid+`' WHERE environmentWindSpeedTrue < `+wsp+` AND  environmentWindSpeedTrue > `+wspLow+` AND environmentWindAngleTrueGround < `+Math.PI+` AND environmentWindAngleTrueGround > 0 ORDER BY performanceVelocityMadeGood DESC LIMIT 1`
      //app.debug(query)
      perfPromises.push(db.prepare(query).get())
      query = `SELECT environmentWindAngleTrueGround, navigationSpeedThroughWater FROM '`+uuid+`' WHERE environmentWindSpeedTrue < `+wsp+` AND  environmentWindSpeedTrue > `+wspLow+` AND environmentWindAngleTrueGround < 0 AND environmentWindAngleTrueGround > `+-Math.PI+` ORDER BY performanceVelocityMadeGood DESC LIMIT 1`
      perfPromises.push(db.prepare(query).get())
      query = `SELECT environmentWindAngleTrueGround, navigationSpeedThroughWater FROM '`+uuid+`' WHERE environmentWindSpeedTrue < `+wsp+` AND  environmentWindSpeedTrue > `+wspLow+` AND environmentWindAngleTrueGround < `+Math.PI+` AND environmentWindAngleTrueGround > 0 ORDER BY performanceVelocityMadeGood ASC LIMIT 1`
      perfPromises.push(db.prepare(query).get())
      query = `SELECT environmentWindAngleTrueGround, navigationSpeedThroughWater FROM '`+uuid+`' WHERE environmentWindSpeedTrue < `+wsp+` AND  environmentWindSpeedTrue > `+wspLow+` AND environmentWindAngleTrueGround < 0 AND environmentWindAngleTrueGround > `+-Math.PI+` ORDER BY performanceVelocityMadeGood ASC LIMIT 1`
      perfPromises.push(db.prepare(query).get())
      var p = Promise.all(perfPromises)
      .catch(error => console.log(`Error in getPerf: ${error}`))
      return p
    }

    var polarData
    const speedLoop = async (uuid) => {
      response = await getInfo(uuid)
      var windSpeedArray
      if(uuid == mainPolarUuid){
        windSpeedArray = []
        for(var windspeed = twsInterval; windspeed < maxWind;windspeed+=twsInterval){
          windSpeedArray.push(windspeed)
        }
      }
      else {
        windSpeedArray = await getWindSpeedArray(uuid)
      }

      let windPromises = []
      windSpeedArray.forEach(function(element, index, array){
        let wsp = element
        var wspLow
        index>=1?wspLow=array[index-1]:wspLow=0
        polarData = []


        const angleLoop = async (wsp) => {
          let anglePromises = [];
          var data = await getPerf(uuid, wsp, wspLow).then(values =>{
            var data = {
              "trueWindSpeed":wsp,
              "beatAngles": [],
              "beatSpeeds": [],
              "gybeAngles": [],
              "gybeSpeeds": [],
              "trueWindAngles": [],
              "polarSpeeds": [],
              "velocitiesMadeGood": []
            }
            //app.debug(JSON.stringify(values))
            if(values[0] !== null && values[0] != 'null' && values[0] !== undefined && values[0] != 'undefined'){
              var value = JSON.parse(JSON.stringify(values[0]))
              data.beatAngles.push(value.environmentWindAngleTrueGround)
              data.beatSpeeds.push(value.navigationSpeedThroughWater)
            }
            if(values[1] !== null && values[1] != 'null' && values[1] !== undefined && values[1] != 'undefined'){
              var value = JSON.parse(JSON.stringify(values[1]))
              data.beatAngles.push(value.environmentWindAngleTrueGround)
              data.beatSpeeds.push(value.navigationSpeedThroughWater)
            }
            if(values[2] !== null && values[2] != 'null' &&values[2] !== undefined && values[2] != 'undefined'){
              var value = JSON.parse(JSON.stringify(values[2]))
              data.gybeAngles.push(value.environmentWindAngleTrueGround)
              data.gybeSpeeds.push(value.navigationSpeedThroughWater)
            }
            if(values[3] !== null && values[3] != 'null' && values[3] !== undefined && values[3] != 'undefined'){
              var value = JSON.parse(JSON.stringify(values[3]))
              data.gybeAngles.push(value.environmentWindAngleTrueGround)
              data.gybeSpeeds.push(value.navigationSpeedThroughWater)
            }
            //app.debug("getPerfAsync: ", JSON.stringify(data))
            return (data)
          })
          var windAngleArray = []

          if(uuid == mainPolarUuid){
            //If at the dynamic polar, we still want to produce polars with angles to set interval
            for (var angle = -Math.PI; angle < Math.PI; angle +=twaInterval){
              //app.debug(wsp + " m/s, angle: " + angle)
              windAngleArray.push(angle)
            }
          }
          else {
            var windAngleArray = await getWindAngleArray(uuid, wsp, wspLow)
          }


          windAngleArray.forEach(function(angle, index, array){
            data.trueWindAngles.push(angle)
            var angleHigh = angle + twaInterval*0.5
            var angleLow = angle - twaInterval*0.5
            //wspLow = wsp - twsInterval
            var query = `SELECT performanceVelocityMadeGood AS vmg, navigationSpeedThroughWater AS speed FROM '`+uuid+`' WHERE environmentWindSpeedTrue < ` + wsp +` AND  environmentWindSpeedTrue > ` + wspLow+` AND environmentWindAngleTrueGround < ` + angleHigh +` AND environmentWindAngleTrueGround > ` + angleLow +` ORDER BY navigationSpeedThroughWater DESC`
            //app.debug(query)
            anglePromises.push(db.prepare(query).get())
            //}
          })
          //app.debug(util.inspect(anglePromises))
          const results = await Promise.all(anglePromises)

          //app.debug(JSON.stringify(results))
          results.forEach(angleFunction);

          function angleFunction(result, index) {
            if (result != undefined) {
              result.speed?data.polarSpeeds.push(result.speed):data.polarSpeeds.push(null)
              result.vmg?data.velocitiesMadeGood.push(result.vmg):data.velocitiesMadeGood.push(null)
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
        return array.filter(Boolean).length;
      }
      function trimPolar(){
        var trimmedPolar = []
        response[uuid].polarData.forEach((data) => {
          var arraysToCheck = [data.beatAngles, data.gybeAngles, data.beatSpeeds, data.gybeSpeeds, data.polarSpeeds, data.velocitiesMadeGood]
          var arrayNum = 6
          arraysToCheck.forEach((x)=>{
            if(countNonEmpty(x)<=0){
              arrayNum-=1
            }
          })
          if (arrayNum != 0){
            trimmedPolar.push(data)
          }

        })
        app.debug("trim polar finished")
        return trimmedPolar
      }
      //response[uuid].polarTable = []
      //var trimmedPolar = trimPolar()
      //response[uuid].polarData = trimmedPolar
      //app.debug(JSON.stringify(response))
      return response //was res.send(response)
    }
    return new Promise(
      (resolve, reject) => {
        var res = speedLoop(uuid)
        resolve(res)
      }
    )

  }

  function handleDelta(delta, options) {
    if(delta.updates && delta.context === selfContext) {
      delta.updates.forEach(update => {
        if(update.values && typeof update.source != 'undefined' && (update.source.talker != 'signalk-polar')) {
          var points = update.values.reduce((acc, pathValue, options) => {
            if(typeof pathValue.value === 'number' && engineSKPath != "doNotStore") {//propulsion.*.state is not number!
              var storeIt = shouldStore(pathValue.path);

              if ( storeIt) {
                //app.debug(update.timestamp + " " + pathValue.path + " " + pathValue.value)
                if (pathValue.path == "navigation.rateOfTurn"){
                  var rotTime = new Date(update.timestamp);
                  rotTimeSeconds = rotTime.getTime() / 1000; //need to convert to seconds for comparison
                  rot = pathValue.value;
                }
                if (pathValue.path == "navigation.speedThroughWater"){
                  var stwTime = new Date(update.timestamp);
                  stwTimeSeconds = stwTime.getTime() / 1000;
                  stw = pathValue.value;
                }
                if (pathValue.path == "environment.wind.angleApparent"){
                  var awaTime = new Date(update.timestamp);
                  awaTimeSeconds = awaTime.getTime() / 1000;
                  awa = pathValue.value;
                }
                if (pathValue.path == "environment.wind.angleTrueGround"){
                  twa = pathValue.value;
                  var twaTime = new Date(update.timestamp);
                  twaTimeSeconds = twaTime.getTime() / 1000
                }
                if (pathValue.path == "environment.wind.speedApparent"){
                  var awsTime = new Date(update.timestamp);
                  awsTimeSeconds = awsTime.getTime() / 1000;
                  aws = pathValue.value;
                }
                if (pathValue.path == "environment.wind.speedTrue"){
                  tws = pathValue.value;
                  var twsTime = new Date(update.timestamp);
                  twsTimeSeconds = twsTime.getTime() / 1000
                }
                if (pathValue.path == "navigation.courseOverGroundTrue"){
                  var cogTime = new Date(update.timestamp);
                  cogTimeSeconds = cogTime.getTime() / 1000;
                  cog = pathValue.value;
                }
                if (pathValue.path == "navigation.speedOverGround"){
                  var sogTime = new Date(update.timestamp);
                  sogTimeSeconds = sogTime.getTime() / 1000;
                  sog = pathValue.value;
                }
                if (pathValue.path == "performance.velocityMadeGood"){
                  vmg = pathValue.value;
                  var vmgTime = new Date(update.timestamp);
                  vmgTimeSeconds = vmgTime.getTime() / 1000
                }
                var engTime;
                if (engineSKPath != "AlwaysOff" && engineSKPath != "doNotStore"){
                  if (pathValue.path == engineSKPath){
                    engTime = new Date(update.timestamp);
                    engTimeSeconds = engTime.getTime() / 1000;
                    eng = pathValue.value;
                  }
                }
                else {
                  engTime = new Date(update.timestamp); //take the last timestamp
                  engTimeSeconds = engTime.getTime() / 1000;
                }


                //app.debug("times: " /*+ rotTimeSeconds + " "*/ + stwTimeSeconds + " " + awaTimeSeconds + " " + engTimeSeconds)
                //app.debug("rot: " +rot + " stw: " + stw + " awa: " + awa+ " eng: " + eng)
                var timeMax = Math.max(/*rotTimeSeconds,*/ stwTimeSeconds, awaTimeSeconds, awsTimeSeconds, cogTimeSeconds);
                var timeMin = Math.min(/*rotTimeSeconds,*/ stwTimeSeconds, awaTimeSeconds, awsTimeSeconds, cogTimeSeconds);
                var timediff = timeMax - timeMin; //check that values are fairly concurrent
                //app.debug("time diff " + timediff)


                if ((engineSKPath.indexOf(".state") > -1) && (eng != '[object Object]' && eng == 'started')){
                  engineRunning = true;
                } else if ((engineSKPath.indexOf(".revolutions") > -1 ) && (eng <= 1)){ //RPM = 0
                  engineRunning = true;
                } else  {
                  engineRunning = false;
                }
                //app.debug("engine running? " + engineRunning)
                if (Math.abs(rot*3437) < rateOfTurnLimit){stableCourse = true;
                }
                else stableCourse = false;
                //app.debug("stable course? " + stableCourse +" "+ Math.abs(rot*3437) + " deg/min compared to " + rateOfTurnLimit)

                //app.debug("timediff " + timediff + " , engine running? " + engineRunning + " stable? " + stableCourse +" last store " + lastStored)
                if (timediff < maxInterval && !engineRunning  && stableCourse && lastStored < timeMax - 1){
                  app.debug("sailing")
                  if(timeMax - twsTimeSeconds > 1){
                    tws = getTrueWindSpeed(stw, aws, awa);
                  }
                  if (timeMax - twaTimeSeconds > 1){
                    twa = getTrueWindAngle(stw, tws, aws, awa);
                  }
                  if (timeMax - vmgTimeSeconds > 1){
                    vmg = getVelocityMadeGood(stw, twa);
                  }

                  /*if (secondsSincePush < timeMax - 1){
                  app.debug("time to push")
                  pushDelta(app,  {"key": "environment.wind.speedTrue", "value": tws});
                  pushDelta(app,  {"key": "environment.wind.angleTrueWater", "value": twa});
                  pushDelta(app,  {"key": "performance.velocityMadeGood", "value": vmg});
                  secondsSincePush = timeMax;
                }*/
                //tack is implicit in wind angle, no need to check (or store)
                //but check if rot between limits -5deg/min < rot < 5deg/min

                //app.debug(`SELECT * FROM polar Where environmentWindSpeedTrue <= `+ tws + ` AND environmentWindAngleTrueGround = ` + twa + ` AND navigationSpeedThroughWater >= `+ stw )
                //@TODO: change to memory function
                db.prepare(`SELECT * FROM polar
                  Where environmentWindSpeedTrue <= ?
                  AND environmentWindAngleTrueGround = ?
                  AND navigationSpeedThroughWater >= ?`, (err,row) => {

                    if(err){
                      app.debug(err)
                      return app.debug(err)
                    }

                    app.debug("response type: " + typeof (row))
                    if(typeof row !== 'object' || row.navigationSpeedThroughWater === 'undefined') {
                      //no better performance found from history
                      app.debug("time to update")
                      if (awa < 0) {
                        tack = "port";
                      }
                      else {
                        tack = "starboard";
                      }

                      var timeMaxIso = new Date(timeMax*1000).toISOString()

                      db.prepare(`INSERT INTO ${polarName}
                        (timestamp, environmentWindSpeedApparent, environmentWindSpeedTrue, environmentWindAngleApparent, environmentWindAngleTrueGround, navigationSpeedThroughWater, performanceVelocityMadeGood, tack)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ? )`, function(err,row){
                          if(err) {
                            app.debug(err);
                            app.setProviderError(err)
                          }

                          else {

                            app.debug("New entry written to db")
                            app.setProviderStatus("writing to db")
                          }
                        }).run([timeMaxIso, aws, tws, awa, twa, stw, vmg, tack])
                      } else {
                        app.debug('Data received from db, stw: ' + row.navigationSpeedThroughWater)
                      }
                      return
                    }).get([tws, twa, stw]);
                  }
                }
              }
              return acc;
            }, []);
          }
        });
      }
    }

    return {
      id: "signalk-polar",
      name: "Polar storage and retrieval",
      description: "Signal K server plugin that stores and retrieves polar data from sqlite3 database",

      uiSchema: {
        mainPolarUuid: {"ui:widget": "hidden"},
        entered: {
          items: {
            polarUuid: {"ui:widget": "hidden"},
            csvTable: {"ui:widget": "textarea"}
          }
        }
      },
      schema: {
        type: "object",
        title: "A Signal K (node) plugin to maintain polar diagrams in a sqlite3 database",
        description: "",
        required: [
          "engine", "sqliteFile"
        ],

        properties: {
          engine: {
            type: "string",
            title: "How is engine status monitored - stores to polar only when engine off",
            default: "doNotStore",
            "enum": ["alwaysOff", "propulsion.*.revolutions", "propulsion.*.state", "doNotStore"],
            enumNames: ["assume engine always off", "propulsion.*.revolutions > 0", "propulsion.*.state is not \'started\'", "do not store dynamic polar"]
          },
          additional_info: {
            type: "string",
            title: "replace * in \'propulsion.*.revolutions\' or \'propulsion.*.state\' with [ ]"
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
            title: "Store in database if rate of turn is less than [ ] deg/min (inertia gives false reading while turning vessel)",
            default: 5
          },
          entered: {
            type: "array",
            title: "User input polars",
            items: {
              title: " ",
              type: "object",
              properties: {
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
                  "enum": ["rad", "deg"],
                  enumNames: ["Radians", "Degrees"]
                },
                windSpeedUnit: {
                  type: "string",
                  title: "Unit for wind speed",
                  default: "knots",
                  "enum": ["knots", "ms", "kph", "mph"],
                  enumNames: ["Knots", "m/s", "km/h", "mph"]
                },
                boatSpeedUnit: {
                  type: "string",
                  title: "Unit for boat speed",
                  default: "knots",
                  "enum": ["knots", "ms", "kph", "mph"],
                  enumNames: ["Knots", "m/s", "km/h", "mph"]
                },
                csvTable: {
                  type: "string",
                  title: "enter csv with polar in http://jieter.github.io/orc-data/site/ style"
                }
              }
            }
          }
        }
      },

      start: function(options) {
        dbFile = options.sqliteFile
        twaInterval = options.angleResolution*Math.PI/180
        twsInterval = options.twsInterval
        app.debug("twsInterval: " + twsInterval)
        polarDescription = options.polarDescription
        maxWind = options.maxWind
        if (options.mainPolarUuid) {
          mainPolarUuid = options.mainPolarUuid
          console.log("Polar uuid exists: " + mainPolarUuid, typeof(mainPolarUuid))
        } else {
          mainPolarUuid = uuidv4()
          options.mainPolarUuid = mainPolarUuid
          console.log("Polar uuid does not exist, creating " + mainPolarUuid)
          app.savePluginOptions(options, function(err,result){
            if(err){
              console.log(err)
            }
          })
        }
        db = new Database(options.sqliteFile, { timeout: 10000 });
        polarName = options.polarName.replace(/ /gi, "_")
        app.debug("polar name is " + polarName)
        var create
        create = db.prepare(`CREATE TABLE IF NOT EXISTS tableUuids (uuid TEXT UNIQUE NOT NULL, name TEXT, description TEXT)`).run()
        create = db.prepare(`CREATE TABLE IF NOT EXISTS '${mainPolarUuid}' (
          timestamp TEXT,
          environmentWindSpeedApparent DOUBLE DEFAULT NULL,
          environmentWindSpeedTrue DOUBLE DEFAULT NULL,
          environmentWindAngleApparent DOUBLE DEFAULT NULL,
          environmentWindAngleTrueGround DOUBLE DEFAULT NULL,
          navigationSpeedThroughWater DOUBLE DEFAULT NULL,
          performanceVelocityMadeGood DOUBLE DEFAULT NULL,
          tack TEXT,
          navigationRateOfTurn DOUBLE DEFAULT NULL)`).run()
          db.prepare('INSERT OR REPLACE INTO tableUuids (`uuid`, `name`, `description`) VALUES( ?,?,?)').run([mainPolarUuid, polarName, polarDescription])

          db.prepare(`CREATE INDEX IF NOT EXISTS main_wst ON '${mainPolarUuid}' (environmentWindSpeedTrue)`).run()

          db.prepare(`CREATE INDEX IF NOT EXISTS main_watg ON '${mainPolarUuid}' (environmentWindAngleTrueGround)`).run()


          if(options.entered && options.entered.length > 0 ){


            options.entered.forEach(table => {
              var tableName = table.polarName.replace(/ /gi, "_")
              var tableUuid
              if (table.polarUuid) {
                tableUuid = table.polarUuid
                console.log("Polar uuid exists: '" + tableUuid + "'", typeof(tableUuid))
              } else {
                tableUuid = uuidv4()
                table.polarUuid = tableUuid
                console.log("Polar uuid does not exist, creating '" + tableUuid + "'")
                app.savePluginOptions(options, function(err,result){
                  if(err){
                    console.log(err)
                  }
                })
              }
              //db = new Database(options.sqliteFile, { timeout: 10000 })
              app.debug("polar name is " + tableName)
              create = db.prepare(`DROP TABLE IF EXISTS '${tableUuid}'`).run()
              db.prepare(`CREATE TABLE IF NOT EXISTS '${tableUuid}' (
                environmentWindSpeedTrue DOUBLE DEFAULT NULL,
                environmentWindAngleTrueGround DOUBLE DEFAULT NULL,
                navigationSpeedThroughWater DOUBLE DEFAULT NULL,
                performanceVelocityMadeGood DOUBLE DEFAULT NULL)`).run()

                db.prepare('INSERT OR REPLACE INTO tableUuids (`uuid`, `name`, `description`) VALUES( ?,?,?)').run([tableUuid, tableName, table.description])

                db.prepare(`CREATE INDEX IF NOT EXISTS ${tableName}_wst ON '${tableUuid}' (environmentWindSpeedTrue)`)

                db.prepare(`CREATE INDEX IF NOT EXISTS ${tableName}_watg ON '${tableUuid}' (environmentWindAngleTrueGround)`).run()


                var output = []

                parse(table.csvTable, {
                  trim: true,
                  skip_empty_lines: true,
                  delimiter: ';'
                })
                // Use the readable stream api
                .on('readable', function(){
                  let record
                  while (record = this.read()) {
                    output.push(record)
                  }
                  //app.debug(JSON.stringify(output))
                  var windSpeeds = []
                  output[0].forEach(listSpeeds)
                  function listSpeeds(item, index) {
                    if (index>0){ //first is "twa/tws"
                    //var windSpeedItem = item//@TODO: remove and replace with below
                    var windSpeedItem = utilSK.transform(item, table.windSpeedUnit, 'ms')
                    windSpeeds.push(Number(windSpeedItem))
                  }
                }
                //app.debug("windspeeds: " + JSON.stringify(windSpeeds))
                output.forEach(storeSpeeds)
                function storeSpeeds(item,index){
                  if (index>0){//first row is header, and already parsed
                    //var itemAngle = Number(item[0])//@TODO: remove and replace with below
                    var itemAngle = utilSK.transform(Number(item[0]), table.angleUnit, 'rad')
                    //app.debug("itemAngle: " +itemAngle)
                    item.forEach(storeSpeed)
                    function storeSpeed(speedItem, index){
                      //var speed = Number(speedItem)//@TODO: replace with below
                      var speed = utilSK.transform(speedItem, table.boatSpeedUnit, 'ms');
                      if (index>0 && speedItem>0){//first item is angle, already parsed
                        var vmg = getVelocityMadeGood(speed, itemAngle)
                        //app.debug(`INSERT INTO '${tableUuid} '(environmentWindSpeedTrue, environmentWindAngleTrueGround, navigationSpeedThroughWater, performanceVelocityMadeGood ) VALUES (${windSpeeds[index-1]}, ${itemAngle}, ${speed}, ${vmg})`)
                        db.prepare(`INSERT INTO '${tableUuid}'(environmentWindSpeedTrue, environmentWindAngleTrueGround, navigationSpeedThroughWater, performanceVelocityMadeGood ) VALUES (${windSpeeds[index-1]}, ${itemAngle}, ${speed}, ${vmg})`).run()

                        //app.debug("windspeed: " + windSpeeds[index-1] + " angle: " + itemAngle + " boatspeed: " + speed)
                      }
                    }

                  }
                }
              })
            })

          }
          // else {
          //   db.prepare(`SELECT * FROM sqlite_master WHERE type='table'`, function(err, rows){
          //     if(err){
          //       app.debug("find unused tables error: " + err.message);
          //     } else {
          //       rows.forEach(row => {
          //         if(row.name != 'tableUuids'){
          //           app.debug("table found: " + row.name);
          //           //db.prepare(`DROP TABLE ${row.name}`).run()
          //           //
          //         }
          //
          //       })
          //     }
          //   }).all()
          //   // delete all user entered polars
          // }

          const getAllPolars = async() =>{
            const polarList = await listPolarTables()
            const results = await Promise.all(polarList.map((item) => {
              return getPolarTable(item.uuid);
            }))
            var polars = {
              "polars": results
            }
            return results
          }
          async function mainPolarFunc() {
            const response = await getAllPolars()
            app.debug(response)
            allPolars = response
          }
          mainPolarFunc()




          //@TODO: change this to get from memory at start, and keep in memory
          //@TODO: when values change and not fixed interval?
          pushInterval = setInterval(function() {
            //app.debug("tws: " + tws + " abs twa: " + Math.abs(twa) + " stw: " + stw)
            getTarget(app, polarName, tws, twsInterval, Math.abs(twa), twaInterval, stw);
            //app.debug("sent to setInterval:" +  tws + " : " + twsInterval + " : " + Math.abs(twa) + " : " + twaInterval);
          }, 1000);

          app.debug("started");




          var obj = {};
          if (options.engine == 'propulsion.*.revolutions'){
            items.push(options.engine.replace(/\*/g, options.additional_info));
            engineSKPath = options.engine.replace(/\*/g, options.additional_info);
          }
          else if (options.engine == 'propulsion.*.state'){
            items.push(options.engine.replace(/\*/g, options.additional_info));
            engineSKPath = options.engine.replace(/\*/g, options.additional_info);
          }
          else if (options.engine == "alwaysOff"){
            engineSKPath = "alwaysOff";
          }
          else if(options.engine == "doNotStore"){
            engineSKPath = "doNotStore"
          }
          rateOfTurnLimit = options.rateOfTurnLimit
          //app.debug("listening for " + util.inspect(items));
          //app.debug("engineSKPath: " + engineSKPath);
          items.forEach(element => {
            obj[element] = true;
          });

          shouldStore = function(path) {
            return typeof obj[path] != 'undefined';
          };

          app.signalk.on('delta', handleDelta);


        },
        registerWithRouter: function(router) {
          //@TODO: add put message to delete table

          router.get('/polarTables', (req, res) => {
            res.contentType('application/json');
            res.send(allPolars)
          })

          router.get('/polarTable', (req, res) => {
            res.contentType('application/json')
            var uuid = req.query.uuid
            var response = allPolars[uuid]
            console.log(response)
            res.send(response)
          })

          router.get('/listPolarTables', (req, res) => {
            res.contentType('application/json')
            db.prepare("select * from tableUuids", function (err, tables) {
              // error will be an Error if one occurred during the query
              if(err){
                app.debug("registerWithRouter error: " + err.message);
              }
              res.send(JSON.stringify(tables))
            }).all()

          })

          router.get('/listWindSpeeds', (req, res) => {
            //list all wind speeds for a polar diagram

            res.contentType('application/json');
            var table = req.query.table

            db.prepare(`SELECT DISTINCT round(environmentWindSpeedTrue,1) as windSpeed FROM ${table} ORDER BY windSpeed ASC`, function (err, tables) {
              // error will be an Error if one occurred during the query
              if(err){
                app.debug("registerWithRouter error: " + err.message);
              }
              res.send(JSON.stringify(tables))
            }).all()

          })

        },


        stop: function() {
          app.debug("Stopping")
          unsubscribes.forEach(f => f());
          items.length = items.length - 1;
          engineSKPath = "";

          //db.close();


          clearInterval(pushInterval);

          app.signalk.removeListener('delta', handleDelta);
          app.debug("Stopped")
        }
      }

      function getTarget(app, polarName, trueWindSpeed, windInterval, trueWindAngle, twaInterval, speedThroughWater) {
        //app.debug("getTarget called")
        //@TODO: replace with memory
        db.prepare(`SELECT * FROM '${mainPolarUuid}'
        WHERE environmentWindSpeedTrue < ?
        AND environmentWindSpeedTrue > ?
        ORDER BY performanceVelocityMadeGood
        DESC`, function(err, row){
          // error will be an Error if one occurred during the query
          if(err){
            app.debug("tack error: " + err.message);
          }

          if (row){
            //app.debug("target tack angle: " + row.environmentWindAngleTrueGround + " speed: " + row.navigationSpeedThroughWater);
            pushDelta(app,  {"key": "performance.beatAngle", "value": Math.abs(row.environmentWindAngleTrueGround)});
            pushDelta(app,  {"key": "performance.beatAngleTargetSpeed", "value": row.navigationSpeedThroughWater});
            pushDelta(app,  {"key": "performance.beatAngleVelocityMadeGood", "value": row.performanceVelocityMadeGood});
            if (Math.abs(trueWindAngle) < Math.PI/2){
              pushDelta(app,  {"key": "performance.targetAngle", "value": Math.abs(row.environmentWindAngleTrueGround)});
              pushDelta(app,  {"key": "performance.targetSpeed", "value": row.navigationSpeedThroughWater});
            }

          }
        }
      ).get([trueWindSpeed, trueWindSpeed - windInterval]);

      db.prepare(`SELECT * FROM '${mainPolarUuid}'
      WHERE environmentWindSpeedTrue < ?
      AND environmentWindSpeedTrue > ?
      ORDER BY performanceVelocityMadeGood
      ASC`, function(err, row){

        // error will be an Error if one occurred during the query
        if(err){
          app.debug("gybe error: " + err.message);
        }

        if (row){

          //app.debug("target gybe angle: " + row.environmentWindAngleTrueGround + " speed: " + row.navigationSpeedThroughWater);
          pushDelta(app,  {"key": "performance.gybeAngle", "value": Math.abs(row.environmentWindAngleTrueGround)});
          pushDelta(app,  {"key": "performance.gybeAngleTargetSpeed", "value": row.navigationSpeedThroughWater});
          pushDelta(app,  {"key": "performance.gybeAngleVelocityMadeGood", "value": Math.abs(row.performanceVelocityMadeGood)});
          if (Math.abs(trueWindAngle) > Math.PI/2){
            pushDelta(app,  {"key": "performance.targetAngle", "value": Math.abs(row.environmentWindAngleTrueGround)});
            pushDelta(app,  {"key": "performance.targetSpeed", "value": row.navigationSpeedThroughWater});
          }


        }
      }
    ).get([trueWindSpeed, trueWindSpeed - windInterval]);


    db.prepare(`SELECT * FROM '${mainPolarUuid}'
    WHERE environmentWindSpeedTrue < ?
    AND ABS(environmentWindAngleTrueGround) < ?
    AND ABS(environmentWindAngleTrueGround) > ?
    ORDER BY navigationSpeedThroughWater
    DESC`, function (err, row) {

      // error will be an Error if one occurred during the query
      if(err){
        app.debug("polar error: " + err.message);
      }

      // results will contain the results of the query
      if (row){
        //app.debug("polarSpeed: " + row.navigationSpeedThroughWater + " ratio: " + speedThroughWater/row.navigationSpeedThroughWater)
        pushDelta(app,  {"key": "performance.polarSpeed", "value": row.navigationSpeedThroughWater});
        pushDelta(app,  {"key": "performance.polarSpeedRatio", "value": speedThroughWater/row.navigationSpeedThroughWater});
      }
    }
  ).get([trueWindSpeed, trueWindAngle, trueWindAngle - twaInterval]);
}
}

/*function getTrueWindAngle(speed, trueWindSpeed, apparentWindspeed, windAngle) {
//cosine rule
// a2=b2+c2−2bc⋅cos(A) where
//a is apparent wind speed,
//b is boat speed and
//c is true wind speed

var aSquared = Math.pow(apparentWindspeed,2);
var bSquared = Math.pow(trueWindSpeed,2);
var cSquared = Math.pow(speed,2);
var cosA =  (aSquared - bSquared - cSquared) / (2 * trueWindSpeed * speed);

if (windAngle === 0) {
return 0;
}
else if (windAngle == Math.PI) {
return Math.PI;
}

else if (cosA > 1 || cosA < -1){
console.log("invalid triangle aws: " + apparentWindspeed + " tws: " + trueWindSpeed + " bsp: " + speed);
return null;
}

else {
var calc;
if (windAngle > 0 && windAngle < Math.PI){ //Starboard
calc = Math.acos(cosA);
} else if (windAngle < 0 && windAngle > -Math.PI){ //Port
calc = -Math.acos(cosA);
}
return calc;
}
}*/

function getTrueWindAngle(speed, trueWindSpeed, apparentWindspeed, windAngle) {
  // alpha=arccos((A*cos(beta)-V)/W)
  //A is apparent wind speed,
  //beta is apparent wind angle
  //V is boat speed
  //W is true wind speed
  //alpha is true wind angle


  var cosAlpha =  (apparentWindspeed*Math.cos(windAngle)-speed)/(trueWindSpeed);

  if (windAngle === 0) {
    return 0;
  }
  else if (windAngle == Math.PI) {
    return Math.PI;
  }

  else if (cosAlpha > 1 || cosAlpha < -1){
    console.log("invalid triangle aws: " + apparentWindspeed + " tws: " + trueWindSpeed + " bsp: " + speed);
    return null;
  }

  else {
    var calc;
    if (windAngle >= 0 && windAngle <= Math.PI){ //Starboard
      calc = Math.acos(cosAlpha);
    } else if (windAngle < 0 && windAngle > -Math.PI){ //Port
      calc = -Math.acos(cosAlpha);
    }
    console.log("true wind angle: " + calc)
    return calc;
  }
}

function getTrueWindSpeed(speed, windSpeed, windAngle) {
  //app.debug("getTrueWindSpeed called")
  //var apparentX = Math.cos(windAngle) * windSpeed;
  //var apparentY = Math.sin(windAngle) * windSpeed;
  //return Math.sqrt(Math.pow(apparentY, 2) + Math.pow(-speed + apparentX, 2));
  return Math.sqrt(Math.pow(windSpeed, 2) + Math.pow(speed, 2) - 2*windSpeed*speed*Math.cos(windAngle))
}

function getVelocityMadeGood(speed, trueWindAngle) {
  //app.debug("getVelocityMadeGood called")
  return Math.cos(trueWindAngle) * speed;
}

function pushDelta(app, command_json) {
  var key = command_json["key"]
  var value = command_json["value"]


  const data = {
    context: "vessels." + app.selfId,
    updates: [
      {
        source: {"type":"server","sentence":"none","label":"calculated","talker":"signalk-polar"},
        timestamp: utilSK.timestamp(),
        values: [
          {
            'path': key,
            'value': value
          }
        ]
      }
    ],
  }

  app.signalk.addDelta(data)
  return
}
