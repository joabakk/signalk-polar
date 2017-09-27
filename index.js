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
const debug = require('debug')('signalk-polar');
const util = require('util');
const utilSK = require('nmea0183-utilities');
const express = require("express");
const _ = require('lodash');
const sqlite3 = require('sqlite3');
var db,json;
var pushInterval;

var vmg, rot, stw, awa, twa, aws, tws, eng, sog, cog, tack;
var engineRunning = true;
var engineSKPath = "";
var twsInterval = 0.1 ;//Wind speed +-0.1 m/s
var twaInterval = 0.0174533 ;//Wind angle +-1 degree
var stableCourse = false;

var vmgTimeSeconds = rotTimeSeconds = stwTimeSeconds = awaTimeSeconds = awsTimeSeconds = engTimeSeconds = cogTimeSeconds = sogTimeSeconds = 0
var secondsSinceStore = 0
var secondsSincePush

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
        if(update.values && (update.source.talker != 'polar-plugin')) {

          var points = update.values.reduce((acc, pathValue, options) => {
            if(typeof pathValue.value === 'number') {//propulsion.*.state is not number!
              var storeIt = shouldStore(pathValue.path);



              if ( storeIt) {

                //debug(update.timestamp + " " + pathValue.path + " " + pathValue.value)
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
                if (pathValue.path == "environment.wind.speedApparent"){
                  var awsTime = new Date(update.timestamp);
                  awsTimeSeconds = awsTime.getTime() / 1000;
                  aws = pathValue.value;
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
                var engTime;
                if (engineSKPath != "AlwaysOff"){
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
                //debug("times: " /*+ rotTimeSeconds + " "*/ + stwTimeSeconds + " " + awaTimeSeconds + " " + engTimeSeconds)
                //debug("rot: " +rot + " stw: " + stw + " awa: " + awa+ " eng: " + eng)
                var timeMax = Math.max(/*rotTimeSeconds,*/ stwTimeSeconds, awaTimeSeconds, awsTimeSeconds, cogTimeSeconds);
                var timeMin = Math.min(/*rotTimeSeconds,*/ stwTimeSeconds, awaTimeSeconds, awsTimeSeconds, cogTimeSeconds);
                var timediff = timeMax - timeMin; //check that values are fairly concurrent
                //debug("time diff " + timediff)

                if (engineSKPath == "AlwaysOff"){
                  engineRunning = false;
                }
                else if ((engineSKPath.indexOf(".state") > -1) && (eng != '[object Object]' && eng != 'started') || (timeMax - engTimeSeconds) > 10){ //state != 'started' or very old engine state data
                engineRunning = false;
              }
              else if ((engineSKPath.indexOf(".revolutions") > -1 ) && (eng <= 1  || (timeMax - engTimeSeconds) > 10)){ //RPM = 0 or very old RPM data
                engineRunning = false;
              }
              else {
                engineRunning = true;
              }
              if (Math.abs(rot) < options.rateOfTurnLimit){stableCourse = true;
              }
              else stableCourse = false;

              if (timediff < maxInterval && engineRunning === false && secondsSinceStore < timeMax - 1){
                //debug("sailing, time to get values")
                tws = getTrueWindSpeed(stw, aws, awa);
                twa = getTrueWindAngle(stw, tws, aws, awa);
                vmg = getVelocityMadeGood(stw, twa);

                if (secondsSincePush < timeMax - 1){
                  pushDelta(app,  {"key": "environment.wind.speedTrue", "value": tws});
                  pushDelta(app,  {"key": "environment.wind.angleTrueWater", "value": twa});
                  pushDelta(app,  {"key": "performance.velocityMadeGood", "value": vmg});
                  secondsSincePush = timeMax;
                }
                //tack is implicit in wind angle, no need to check (or store)
                //but check if rot between limits -5deg/min < rot < 5deg/min

                //debug(`SELECT * FROM polar Where environmentWindSpeedTrue <= `+ tws + ` AND environmentWindAngleTrueGround = ` + twa + ` AND navigationSpeedThroughWater >= `+ stw )

                db.get(`SELECT * FROM polar
                  Where environmentWindSpeedTrue <= ?
                  AND environmentWindAngleTrueGround = ?
                  AND navigationSpeedThroughWater >= ?` ,tws, twa, stw, (err,row) => {

                    if(err){
                      return debug(err)
                    }

                    //debug("response type: " + typeof (row) )
                    if(typeof row !== 'object') {
                      secondsSinceStore = timeMax;
                      if (awa < 0) {
                        tack = "port";
                      }
                      else {
                        tack = "starboard";
                      }

                      var timeMaxIso = new Date(timeMax*1000).toISOString()

                      db.get(`INSERT INTO polar
                        (timestamp, environmentWindSpeedApparent, environmentWindSpeedTrue, environmentWindAngleApparent, environmentWindAngleTrueGround, navigationSpeedThroughWater, performanceVelocityMadeGood, tack)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ? )`, timeMaxIso, aws, tws, awa, twa, stw, vmg, tack, function(err,row){
                          if(err) {
                            debug(err);
                          }

                          else {
                            debug("New entry written to db")
                          }
                        });
                      }
                      else {
                        debug('Data received from db, stw: ' + row.navigationSpeedThroughWater)
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
      }
    }


    return {
      id: "signalk-polar",
      name: "Polar storage and retrieval",
      description: "Signal K server plugin that stores and retrieves polar data from sqlite3 database",

      schema: {
        type: "object",
        title: "A Signal K (node) plugin to maintain polar diagrams in a sqlite3 database",
        description: "",
        required: [
          "engine", "mysql", "user", "password"
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
            title: "replace * in \'propulsion.*.revolutions\' or \'propulsion.*.state\' with [ ] or type GPIO# [ ]"
          },
          sqliteFile: {
            type: "string",
            title: "File for storing sqlite3 data, relative path to this plugin",
            default: "../../polarDatabase.db"
          },
          rateOfTurnLimit: {
            type: "number",
            title: "Store in database if rate of turn is less than [ ] deg/min (inertia gives false reading while turning vessel)",
            default: 5
          }
        }
      },

      start: function(options) {

        db = new sqlite3.Database(options.sqliteFile);

        db.run(`CREATE TABLE IF NOT EXISTS polar (
          timestamp TEXT,
          environmentWindSpeedApparent DOUBLE DEFAULT NULL,
          environmentWindSpeedTrue DOUBLE DEFAULT NULL,
          environmentWindAngleApparent DOUBLE DEFAULT NULL,
          environmentWindAngleTrueGround DOUBLE DEFAULT NULL,
          navigationSpeedThroughWater DOUBLE DEFAULT NULL,
          performanceVelocityMadeGood DOUBLE DEFAULT NULL,
          tack TEXT,
          navigationRateOfTurn DOUBLE DEFAULT NULL)`);

          pushInterval = setInterval(function() {
            //debug("tws: " + tws + " abs twa: " + Math.abs(twa) + " stw: " + stw)
            getTarget(app, tws, twsInterval, Math.abs(twa), twaInterval, stw);
            //debug("sent to setInterval:" +  tws + " : " + twsInterval + " : " + Math.abs(twa) + " : " + twaInterval);
          }, 1000);

          debug("started");




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
          debug("listening for " + util.inspect(items));
          debug("engineSKPath: " + engineSKPath);
          items.forEach(element => {
            obj[element] = true;
          });

          shouldStore = function(path) {
            return typeof obj[path] != 'undefined';
          };

          app.signalk.on('delta', handleDelta);


        },
        registerWithRouter: function(router) {
          router.get('/polarTable', (req, res) => {
            res.contentType('application/json');
            //debug(util.inspect(req.query)); // http://localhost:3000/plugins/signalk-polar/polarTable/?windspeed=4&interval=0.1
            var windspeed = req.query.windspeed;
            var interval = req.query.interval;

            db.all(`SELECT environmentWindAngleTrueGround AS angle,
              MAX(navigationSpeedThroughWater) AS speed
              FROM polar
              WHERE environmentWindSpeedTrue < ?
              AND  environmentWindSpeedTrue > ?
              GROUP BY environmentWindAngleTrueGround
              ORDER BY environmentWindAngleTrueGround`, windspeed, windspeed - interval, function(err, rows){

                // error will be an Error if one occurred during the query
                if(err){
                  debug("registerWithRouter error: " + err.message);
                }
                res.send(JSON.stringify(rows))
              }
            )
            })
        },


      stop: function() {
        unsubscribes.forEach(f => f());
        items.length = items.length - 1;
        engineSKPath = "";
        db.close();

        clearInterval(pushInterval);

        app.signalk.removeListener('delta', handleDelta);
      }
    }

    function getTarget(app, trueWindSpeed, windInterval, trueWindAngle, twaInterval, speedThroughWater) {
      //debug("getTarget called")

      db.get(`SELECT * FROM polar
        WHERE environmentWindSpeedTrue < ?
        AND environmentWindSpeedTrue > ?
        ORDER BY performanceVelocityMadeGood
        DESC`, trueWindSpeed, trueWindSpeed - windInterval, function(err, row){
          // error will be an Error if one occurred during the query
          if(err){
            debug("tack error: " + err.message);
          }

          if (row){

            //debug("target tack angle: " + row.environmentWindAngleTrueGround + " speed: " + row.navigationSpeedThroughWater);
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

      db.get(`SELECT * FROM polar
        WHERE environmentWindSpeedTrue < ?
        AND environmentWindSpeedTrue > ?
        ORDER BY performanceVelocityMadeGood
        ASC`, trueWindSpeed, trueWindSpeed - windInterval, function(err, row){

          // error will be an Error if one occurred during the query
          if(err){
            debug("gybe error: " + err.message);
          }

          if (row){

            //debug("target gybe angle: " + row.environmentWindAngleTrueGround + " speed: " + row.navigationSpeedThroughWater);
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


      db.get(`SELECT * FROM polar
        WHERE environmentWindSpeedTrue < ?
        AND ABS(environmentWindAngleTrueGround) < ?
        AND ABS(environmentWindAngleTrueGround) > ?
        ORDER BY navigationSpeedThroughWater
        DESC`, trueWindSpeed, trueWindAngle, trueWindAngle - twaInterval, function (err, row) {

          // error will be an Error if one occurred during the query
          if(err){
            debug("polar error: " + err.message);
          }

          // results will contain the results of the query
          if (row){
            //debug("polarSpeed: " + row.navigationSpeedThroughWater + " ratio: " + speedThroughWater/row.navigationSpeedThroughWater)
            pushDelta(app,  {"key": "performance.polarSpeed", "value": row.navigationSpeedThroughWater});
            pushDelta(app,  {"key": "performance.polarSpeedRatio", "value": speedThroughWater/row.navigationSpeedThroughWater});
          }
        }
      );
    }
  }

  function getTrueWindAngle(speed, trueWindSpeed, apparentWindspeed, windAngle) {
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
      debug("invalid triangle");
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
  }

  function getTrueWindSpeed(speed, windSpeed, windAngle) {
    //debug("getTrueWindSpeed called")
    var apparentX = Math.cos(windAngle) * windSpeed;
    var apparentY = Math.sin(windAngle) * windSpeed;
    return Math.sqrt(Math.pow(apparentY, 2) + Math.pow(-speed + apparentX, 2));
  }

  function getVelocityMadeGood(speed, trueWindAngle) {
    //debug("getVelocityMadeGood called")
    return Math.cos(trueWindAngle) * speed;
  }

  function pushDelta(app, command_json) {
    var key = command_json["key"]
    var value = command_json["value"]


    const data = {
      context: "vessels." + app.selfId,
      updates: [
        {
          source: {"type":"server","sentence":"none","label":"calculated","talker":"polar-plugin"},
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
