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
const sqlite3 = require('sqlite3');
const uuidv4 = require('uuid/v4')
var db,json;
var pushInterval;

var vmg, rot, stw, awa, twa, aws, tws, eng, sog, cog, tack;
var engineRunning = true;
var engineSKPath = "";
var rateOfTurnLimit
var twsInterval = 0.1 ;//Wind speed +-0.1 m/s
var twaInterval = 0.0174533 ;//Wind angle +-1 degree
var stableCourse = false;

var vmgTimeSeconds = rotTimeSeconds = stwTimeSeconds = twaTimeSeconds = twsTimeSeconds = vmgTimeSeconds = awaTimeSeconds = awsTimeSeconds = engTimeSeconds = cogTimeSeconds = sogTimeSeconds = 0
var lastStored = 1
var secondsSincePush
var mainPolarUuid
var polarName
var polarDescription
var angleResolutionRad
var windSpeedResolution
var maxWind
var dbFile

const DB = require('./sqliteQueries/main');

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

  var unsubscribes = [];
  var shouldStore = function(path) { return true; };

  function handleDelta(delta, options) {
    if(delta.updates && delta.context === selfContext) {
      delta.updates.forEach(update => {
        if(update.values && typeof update.source != 'undefined' && (update.source.talker != 'signalk-polar')) {

          var points = update.values.reduce((acc, pathValue, options) => {
            if(typeof pathValue.value === 'number') {//propulsion.*.state is not number!
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
                  var engTime;
                }


                //app.debug("times: " /*+ rotTimeSeconds + " "*/ + stwTimeSeconds + " " + awaTimeSeconds + " " + engTimeSeconds)
                //app.debug("rot: " +rot + " stw: " + stw + " awa: " + awa+ " eng: " + eng)
                var timeMax = Math.max(/*rotTimeSeconds,*/ stwTimeSeconds, awaTimeSeconds, awsTimeSeconds, cogTimeSeconds);
                var timeMin = Math.min(/*rotTimeSeconds,*/ stwTimeSeconds, awaTimeSeconds, awsTimeSeconds, cogTimeSeconds);
                var timediff = timeMax - timeMin; //check that values are fairly concurrent
                //app.debug("time diff " + timediff)


                if ((engineSKPath.indexOf(".state") > -1) && (eng != '[object Object]' && eng != 'started')){
                  engineRunning = true;
                } else if ((engineSKPath.indexOf(".revolutions") > -1 ) && (eng <= 1)){ //RPM = 0
                  engineRunning = true;
                } else {
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
                db.get(`SELECT * FROM polar
                  Where environmentWindSpeedTrue <= ?
                  AND environmentWindAngleTrueGround = ?
                  AND navigationSpeedThroughWater >= ?` ,tws, twa, stw, (err,row) => {

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

                      db.get(`INSERT INTO ${polarName}
                        (timestamp, environmentWindSpeedApparent, environmentWindSpeedTrue, environmentWindAngleApparent, environmentWindAngleTrueGround, navigationSpeedThroughWater, performanceVelocityMadeGood, tack)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ? )`, timeMaxIso, aws, tws, awa, twa, stw, vmg, tack, function(err,row){
                          if(err) {
                            app.debug(err);
                            app.setProviderError(err)
                          }

                          else {

                            app.debug("New entry written to db")
                            app.setProviderStatus("writing to db")
                          }
                        });
                      } else {
                        app.debug('Data received from db, stw: ' + row.navigationSpeedThroughWater)
                      }
                      return
                    });
                  }
                }
              }
              return acc;
            }, []);
          }
        });
      }}



      return {
        id: "signalk-polar",
        name: "Polar storage and retrieval",
        description: "Signal K server plugin that stores and retrieves polar data from sqlite3 database",

        uiSchema: {
          mainPolarUuid: {"ui:widget": "hidden"},
          entered: {
            items: {
              polarUuid: {"ui:widget": "hidden"}
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
              default: "AlwaysOff",
              "enum": ["AlwaysOff", "propulsion.*.revolutions", "propulsion.*.state"],
              enumNames: ["assume engine always off", "propulsion.*.revolutions > 0", "propulsion.*.state is not \'started\'"]
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
            windSpeedResolution: {
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
                    default: "ms",
                    "enum": ["knots", "ms", "kph", "mph"],
                    enumNames: ["Knots", "m/s", "km/h", "mph"]
                  },
                  boatSpeedUnit: {
                    type: "string",
                    title: "Unit for boat speed",
                    default: "kn",
                    "enum": ["knots", "ms", "kph", "mph"],
                    enumNames: ["Knots", "m/s", "km/h", "mph"]
                  },
                  polarArray: {
                    type: "array",
                    title: "Polar values",
                    items: {
                      title: "Enter your values",
                      type: "object",
                      properties: {
                        "windSpeed": {
                          title: "wind speed",
                          type: "number",
                        },
                        "windAngle": {
                          title: "True wind angle",
                          type: "number"
                        },
                        "boatSpeed": {
                          title: "Boat speed",
                          type: "number"
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },

        start: function(options) {
          dbFile = options.sqliteFile
          angleResolutionRad = options.angleResolution*Math.PI/180
          windSpeedResolution = options.windSpeedResolution
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
          db = new sqlite3.Database(options.sqliteFile);
          polarName = options.polarName.replace(/ /gi, "_")
          app.debug("polar name is " + polarName)
          db.serialize(function() {
            db.run(`CREATE TABLE IF NOT EXISTS tableUuids (uuid TEXT UNIQUE NOT NULL, name TEXT, description TEXT, windResolution DOUBLE DEFAULT NULL, angleResolution DOUBLE DEFAULT NULL)`)
            db.run(`CREATE TABLE IF NOT EXISTS ${polarName} (
              timestamp TEXT,
              environmentWindSpeedApparent DOUBLE DEFAULT NULL,
              environmentWindSpeedTrue DOUBLE DEFAULT NULL,
              environmentWindAngleApparent DOUBLE DEFAULT NULL,
              environmentWindAngleTrueGround DOUBLE DEFAULT NULL,
              navigationSpeedThroughWater DOUBLE DEFAULT NULL,
              performanceVelocityMadeGood DOUBLE DEFAULT NULL,
              tack TEXT,
              navigationRateOfTurn DOUBLE DEFAULT NULL)`);
              db.run('INSERT OR REPLACE INTO tableUuids (`uuid`, `name`, `description`, `windResolution`, `angleResolution`) VALUES( ?,?,?,?,?)', [mainPolarUuid, polarName, polarDescription, windSpeedResolution, angleResolutionRad])
              db.run(`CREATE INDEX IF NOT EXISTS main_wst ON ${polarName} (environmentWindSpeedTrue)`)
              db.run(`CREATE INDEX IF NOT EXISTS main_watg ON ${polarName} (environmentWindAngleTrueGround)`)
            });


            if(options.entered && options.entered.length > 0 ){
              options.entered.forEach(table => {
                var tableName = table.polarName

                db.run(`CREATE TABLE IF NOT EXISTS ${tableName} (
                  environmentWindSpeedTrue DOUBLE DEFAULT NULL,
                  environmentWindAngleTrueGround DOUBLE DEFAULT NULL,
                  navigationSpeedThroughWater DOUBLE DEFAULT NULL,
                  performanceVelocityMadeGood DOUBLE DEFAULT NULL)`, function(err, row){
                    if(err){
                      app.debug("add self entered tables error: " + err.message);
                    } else {

                      var createTestData = function() {

                        var stmt = db.prepare(`insert into ${tableName} values (?, ?, ?, ?)`);
                        table.polarArray.forEach(entry => {
                          var windSpeedSI = utilSK.transform(entry.windSpeed, table.windSpeedUnit, 'ms');
                          var windAngleSI = utilSK.transform(entry.windAngle, table.angleUnit, 'rad');
                          var boatSpeedSI = utilSK.transform(entry.boatSpeed, table.boatSpeedUnit, 'ms');
                          stmt.run(windSpeedSI, windAngleSI, boatSpeedSI, getVelocityMadeGood(boatSpeedSI, windAngleSI))
                        })
                        stmt.finalize();
                      };
                      createTestData(row)
                    }
                  })
                })
              }
              else {
                db.all(`SELECT * FROM sqlite_master WHERE type='table'`, function(err, rows){
                  if(err){
                    app.debug("find unused tables error: " + err.message);
                  } else {
                    rows.forEach(row => {
                      if(row.name != polarName && row.name != 'tableUuids'){
                        app.debug("table found that can be removed: " + row.name);
                        //db.run(`DROP TABLE ${row.name}`)
                      }

                    })
                  }
                })
                // delete all user entered polars
              }
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
              else if (options.engine == "AlwaysOff"){
                engineSKPath = "AlwaysOff";
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
                var dB = new DB(dbFile)
                //app.debug(util.inspect(req.query));
                // http://localhost:3000/plugins/signalk-polar/polarTables/?windspeed=4&interval=0.1
                var windspeed = 0
                var interval
                req.interval?interval = req.interval:interval = windSpeedResolution
                windspeed += interval //no need to check for 0 wind
                var windangle = 0
                var angleInterval = angleResolutionRad
                var table = req.query.table?req.query.table:polarName //@TODO: perhaps better to restrict to uuid and check the remaining from tableUuids in db?
                var uuid = req.query.uuid?req.query.uuid:mainPolarUuid
                var description
                if (table == polarName){
                  description = polarDescription
                } else {
                  description = ""
                }
                //app.debug("querying polarTable from " + table)
                var response = {
                  [uuid] : {
                    "name": table,
                    "$description": description,
                    "source": {
                      "label": "signalk-polar"
                    },
                    "polarData": []
                  }
                }
                var polarData
                const speedLoop = async () => {
                  let windPromises = []
                  for (var wsp = windspeed; wsp < maxWind; wsp+=interval){
                    polarData = []


                    const angleLoop = async (wsp) => {
                      let anglePromises = [];
                      var wspLow = wsp - interval
                      //beat
                      var beatAngles = []
                      var beatSpeeds = []
                      function getBeat(){
                        return new Promise(
                          (resolve, reject) => {
                            query = 'SELECT environmentWindAngleTrueGround, navigationSpeedThroughWater FROM dynamicPolar WHERE environmentWindSpeedTrue < '+wsp+' AND  environmentWindSpeedTrue > '+wspLow+' AND environmentWindAngleTrueGround < '+Math.PI+' AND environmentWindAngleTrueGround > 0 ORDER BY performanceVelocityMadeGood DESC LIMIT 1'
                            db.get(query, function(err, row){
                              // error will be an Error if one occurred during the query
                              if(err){
                                app.debug("beat error: " + err.message);
                              }
                              if (row){
                                beatAngles.push(row.environmentWindAngleTrueGround)
                                beatSpeeds.push(row.navigationSpeedThroughWater)
                              }
                            })
                            query = 'SELECT environmentWindAngleTrueGround, navigationSpeedThroughWater FROM dynamicPolar WHERE environmentWindSpeedTrue < '+wsp+' AND  environmentWindSpeedTrue > '+wspLow+' AND environmentWindAngleTrueGround < 0 AND environmentWindAngleTrueGround > '+-Math.PI+' ORDER BY performanceVelocityMadeGood DESC LIMIT 1'
                            db.get(query, function(err, row){
                              // error will be an Error if one occurred during the query
                              if(err){
                                app.debug("beat error: " + err.message);
                              }
                              if (row){
                                beatAngles.push(row.environmentWindAngleTrueGround)
                                beatSpeeds.push(row.navigationSpeedThroughWater)
                              }
                            })
                            var beat = {beatAngles,beatSpeeds}
                            resolve(beat)
                          })
                        }
                        getBeat()
                      //gybe
                      var gybeAngles = []
                      var gybeSpeeds = []
                      function getGybe(){
                        return new Promise(
                          (resolve, reject) => {
                            query = 'SELECT environmentWindAngleTrueGround, navigationSpeedThroughWater FROM dynamicPolar WHERE environmentWindSpeedTrue < '+wsp+' AND  environmentWindSpeedTrue > '+wspLow+' AND environmentWindAngleTrueGround < '+Math.PI+' AND environmentWindAngleTrueGround > 0 ORDER BY performanceVelocityMadeGood ASC LIMIT 1'
                            db.get(query, function(err, row){
                              // error will be an Error if one occurred during the query
                              if(err){
                                app.debug("beat error: " + err.message);
                              }
                              //app.debug("row: " + util.inspect(row))
                              if (row){
                                //app.debug("row: " + util.inspect(row))
                                gybeAngles.push(row.environmentWindAngleTrueGround)
                                gybeSpeeds.push(row.navigationSpeedThroughWater)
                              }
                            })
                            query = 'SELECT environmentWindAngleTrueGround, navigationSpeedThroughWater FROM dynamicPolar WHERE environmentWindSpeedTrue < '+wsp+' AND  environmentWindSpeedTrue > '+wspLow+' AND environmentWindAngleTrueGround < 0 AND environmentWindAngleTrueGround > '+-Math.PI+' ORDER BY performanceVelocityMadeGood ASC LIMIT 1'
                            db.get(query, function(err, row){
                              // error will be an Error if one occurred during the query
                              if(err){
                                app.debug("beat error: " + err.message);
                              }
                              //app.debug("row: " + util.inspect(row))
                              if (row){
                                //app.debug("row: " + util.inspect(row))
                                gybeAngles.push(row.environmentWindAngleTrueGround)
                                gybeSpeeds.push(row.navigationSpeedThroughWater)
                              }
                            })
                            var gybe = {gybeAngles, gybeSpeeds}
                            resolve(gybe)
                          })
                        }
                        getGybe()

                      var data = {
                        "trueWindSpeed": wsp,
                        "beatAngles": beatAngles,
                        "beatSpeeds": beatSpeeds,
                        "gybeAngles": gybeAngles,
                        "gybeSpeeds": gybeSpeeds,
                        "trueWindAngles": [],
                        "polarSpeeds": [],
                        "velocitiesMadeGood": []
                      }
                      //app.debug("checking wsp: " + wsp )

                      for (var angle = -Math.PI; angle < Math.PI; angle+=angleInterval) {
                        app.debug("checking wsp: " + wsp + " and angle: " + angle)
                        data.trueWindAngles.push(angle)
                        var angleHigh = angle + angleInterval*0.5
                        var angleLow = angle - angleInterval*0.5
                        wspLow = wsp - interval
                        var query = 'SELECT performanceVelocityMadeGood AS vmg, navigationSpeedThroughWater AS speed FROM '+table+' WHERE environmentWindSpeedTrue < ' + wsp +' AND  environmentWindSpeedTrue > ' + wspLow+' AND environmentWindAngleTrueGround < ' + angleHigh +' AND environmentWindAngleTrueGround > ' + angleLow +' ORDER BY navigationSpeedThroughWater DESC'
                        //app.debug(query)
                        anglePromises.push(dB.getPromise(query)
                      )
                    }
                    app.debug(util.inspect(anglePromises))
                    const results = await Promise.all(anglePromises)

                    app.debug(JSON.stringify(results))
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
                }

                const windResults = await Promise.all(windPromises)
                app.debug("windPromises: " + JSON.stringify(windResults))
                windResults.forEach(windFunction)
                function windFunction(polarData, index) {
                  response[uuid].polarData.push(polarData)
                }
                res.send(JSON.stringify(response))
              }
              function populatePolar(){
                return new Promise(
                  (resolve, reject) => {
                    speedLoop()
                    resolve(response)
                  })
                }
                populatePolar()
              })

              router.get('/polarTable', (req, res) => {
                res.contentType('application/json');
                //app.debug(util.inspect(req.query)); // http://localhost:3000/plugins/signalk-polar/polarTable/?windspeed=4&interval=0.1
                var windspeed = req.query.windspeed;
                var interval = req.query.interval;
                var table = req.query.table?req.query.table:polarName
                app.debug("querying polarTable from " + table)

                db.all(`SELECT environmentWindAngleTrueGround AS angle,
                  MAX(navigationSpeedThroughWater) AS speed
                  FROM ${table}
                  WHERE environmentWindSpeedTrue < ?
                  AND  environmentWindSpeedTrue > ?
                  GROUP BY environmentWindAngleTrueGround
                  ORDER BY ABS(environmentWindAngleTrueGround)`, windspeed, windspeed - interval, function(err, rows){

                    // error will be an Error if one occurred during the query
                    if(err){
                      app.debug("registerWithRouter error: " + err.message);
                    }
                    res.send(JSON.stringify(rows))
                  }
                )
              })

              router.get('/listPolarTables', (req, res) => {
                res.contentType('application/json');

                db.serialize(function () {
                  db.all("select name from sqlite_master where type='table'", function (err, tables) {
                    // error will be an Error if one occurred during the query
                    if(err){
                      app.debug("registerWithRouter error: " + err.message);
                    }
                    res.send(JSON.stringify(tables))
                  });
                });

              })

              router.get('/listWindSpeeds', (req, res) => {
                //list all wind speeds for a polar diagram

                res.contentType('application/json');
                var table = req.query.table

                db.serialize(function () {
                  db.all(`SELECT DISTINCT round(environmentWindSpeedTrue,1) as windSpeed FROM ${table} ORDER BY windSpeed ASC`, function (err, tables) {
                    // error will be an Error if one occurred during the query
                    if(err){
                      app.debug("registerWithRouter error: " + err.message);
                    }
                    res.send(JSON.stringify(tables))
                  });
                });

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
            db.get(`SELECT * FROM ${polarName}
              WHERE environmentWindSpeedTrue < ?
              AND environmentWindSpeedTrue > ?
              ORDER BY performanceVelocityMadeGood
              DESC`, trueWindSpeed, trueWindSpeed - windInterval, function(err, row){
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
            );

            db.get(`SELECT * FROM ${polarName}
              WHERE environmentWindSpeedTrue < ?
              AND environmentWindSpeedTrue > ?
              ORDER BY performanceVelocityMadeGood
              ASC`, trueWindSpeed, trueWindSpeed - windInterval, function(err, row){

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
            );


            db.get(`SELECT * FROM ${polarName}
              WHERE environmentWindSpeedTrue < ?
              AND ABS(environmentWindAngleTrueGround) < ?
              AND ABS(environmentWindAngleTrueGround) > ?
              ORDER BY navigationSpeedThroughWater
              DESC`, trueWindSpeed, trueWindAngle, trueWindAngle - twaInterval, function (err, row) {

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
            );
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
