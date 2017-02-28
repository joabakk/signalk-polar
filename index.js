/*
* Copyright 2016 Teppo Kurki <teppo.kurki@iki.fi>
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

//const Influx = require('influx')
const Bacon = require('baconjs')
const debug = require('debug')('signalk-to-influxdb')
const util = require('util')
const mysql = require('mysql')
var connection

vmg = rot = stw = awa = tws = eng = {}
var engineRunning = true
var engineSKPath = ""
var twsInterval = 0.1 //Wind speed +-0.1 m/s
var awaInterval = 0.0174533 //Wind angle +-1 degree

vmgTimeSeconds = rotTimeSeconds = stwTimeSeconds = awaTimeSeconds = twsTimeSeconds = engTimeSeconds = 0

const items = [
  "performance.velocityMadeGood", // if empty, populate from this plugin
  "navigation.rateOfTurn", // if above threshold, vessel is turning and no data is stored
  "navigation.speedThroughWater",
  "environment.wind.angleApparent",
  "environment.wind.speedApparent",
]
const maxInterval = 2 //max interval between updates for all items to avoid updating on stale data

module.exports = function(app, options) {
  var client;
  var selfContext = "vessels." + app.selfId

  var unsubscribes = []
  var shouldStore = function(path) { return true; }

  function handleDelta(delta, options) {
    if(delta.updates && delta.context === selfContext) {
      delta.updates.forEach(update => {
        if(update.values) {

          var points = update.values.reduce((acc, pathValue, options) => {
            if(typeof pathValue.value === 'number') {//propulsion.*.state is not number!
              var storeIt = shouldStore(pathValue.path)



              if ( storeIt ) {
                
                debug(update.timestamp + " " + pathValue.path + " " + pathValue.value)
                if (pathValue.path == "navigation.rateOfTurn"){
                  var rotTime = new Date(update.timestamp)
                  rotTimeSeconds = rotTime.getTime() / 1000 //need to convert to seconds for comparison
                  rot = pathValue.value
                  debug("rot: " + rot + " " + rotTimeSeconds)
                }
                if (pathValue.path == "navigation.speedThroughWater"){
                  var stwTime = new Date(update.timestamp)
                  stwTimeSeconds = stwTime.getTime() / 1000
                  stw = pathValue.value
                  debug("stw: " + stw + " " + stwTimeSeconds)
                }
                if (pathValue.path == "environment.wind.angleApparent"){
                  var awaTime = new Date(update.timestamp)
                  awaTimeSeconds = awaTime.getTime() / 1000
                  awa = pathValue.value
                  debug("awa: " + awa + " " + awaTimeSeconds)
                }
                if (pathValue.path == "environment.wind.speedApparent"){
                  var twsTime = new Date(update.timestamp)
                  twsTimeSeconds = twsTime.getTime() / 1000
                  tws = pathValue.value
                  debug("tws: " + tws + " " + twsTimeSeconds)
                }
                if (engineSKPath != "AlwaysOff"){
                  if (pathValue.path == engineSKPath){
                    var engTime = new Date(update.timestamp)
                    engTimeSeconds = engTime.getTime() / 1000
                    eng = pathValue.value
                  }
                }
                else {
                  var engTime = new Date(update.timestamp) //take the last timestamp
                  engTimeSeconds = engTime.getTime() / 1000
                }
                //debug("times: " + rotTimeSeconds + " " + stwTimeSeconds + " " + awaTimeSeconds + " " + engTimeSeconds)
                //debug("rot: " +rot + " stw: " + stw + " awa: " + awa+ " eng: " + eng)
                timeMax = Math.max(/*rotTimeSeconds,*/ stwTimeSeconds, awaTimeSeconds, twsTimeSeconds)
                timeMin = Math.min(/*rotTimeSeconds,*/ stwTimeSeconds, awaTimeSeconds, twsTimeSeconds)
                timediff = timeMax - timeMin
                //debug("time diff " + timediff)

                if (engineSKPath == "AlwaysOff"){
                  engineRunning = false
                  //debug("1")
                }
                else if ((engineSKPath.indexOf(".state") > -1) && (eng != '[object Object]' && eng != 'started') || (timeMax - engTimeSeconds) > 10){ //state != 'started' or very old engine state data
                engineRunning = false
                //debug("2")
              }
              else if ((engineSKPath.indexOf(".revolutions") > -1 ) && (eng <= 1  || (timeMax - engTimeSeconds) > 10)){ //RPM = 0 or very old RPM data
                engineRunning = false
                //debug("3")
              }
              else {
                engineRunning = true
                //debug("else")
              }
              if (timediff < maxInterval && engineRunning == false){
                //debug("checking...")
                //debug("tws: " + tws + " awa: " + awa + " stw: " + stw)

                connection.query('SELECT * FROM polar Where wind_speed > ? AND wind_speed < ? AND wind_dir > ? AND wind_dir < ?' ,[(tws - twsInterval), (tws + twsInterval), (awa - awaInterval), (awa + awaInterval)],function(err,rows){
                  if(err) debug(err)
                  if(rows.length <= 0) {
                    debug("no match found, inserting new item")
                    if (awa < 0) {
                      tack = "port"
                    }
                    else {tack = "starboard"}
                    var newLine = { "wind_speed": tws, "wind_dir": awa, "boat_speed": stw, "tack": tack}
                    //debug("newline: " + util.inspect(newline))
                    connection.query('INSERT INTO polar SET ?', newLine, function(err,rows){
                      if(err) debug(err)
                  })
                }
                  else {
                    debug('Data received from Db')
                    for (var i = 0; i < rows.length; i++) {
                      //debug(rows[i].name)
                  }
                  //debug(rows)
                }
                });

                // INSERT INTO posts SET `id` = 1, `title` = 'Hello MySQL'
                /*connection.query(("""SELECT MAX(boat_speed) AS polarbs WHERE `wind_speed` > %s AND `wind_speed` < %s AND `wind_dir` > %s AND `wind_dir` < %s""" % ((tws - twsInterval), tws, (wind_dir - winddirminus), (wind_dir + winddirplus))), function (error, results, fields)) {
                if (error) throw error;
                debug('The solution is: ', results[0].polarbs);
              });*/
            }
            //if timediff < 2s and engine AlwaysOff, old update or (0 or !='started')

            acc.push({
              measurement: pathValue.path,
              fields: {
                value: pathValue.value
              }
            })
          }
        }
        return acc
      }, [])
      if(points.length > 0) {
        /*client.writePoints(points, function(err, response) {
        if(err) {
        console.error(err)
        console.error(response)
      }
    })*/
  }
}
})
}
}

return {
  id: "signalk-to-influxdb",
  name: "InfluxDb writer",
  description: "Signal K server plugin that writes self values to InfluxDb",

  schema: {
    type: "object",
    title: "A Signal K (node) plugin to maintain polar diagrams in a mySQL database",
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
      mysql: {
        type: "string",
        title: "mySQL server",
        default: "127.0.0.1"
      },
      user: {
        type: "string",
        title: "mySQL username",
        default: "polar"
      },
      password: {
        type: "string",
        title: "mySQL Password",
        default: "polar"
      },
      rateOfTurn: {
        type: "number",
        title: "Store in database if rate of turn is less than [ ] deg/min (inertia gives false reading while turning vessel)",
        default: 5
      }
    }
  },

  start: function(options) {
    connection = mysql.createConnection({
      host     : options.mysql,
      user     : options.user,
      password : options.password,
      database : 'polar'
    });

    connection.connect(function(err) {
      if (err) {
        debug('error connecting: ' + err.stack);
        return;
      }

      debug('connected to mysql as id ' + connection.threadId );
    });
    debug("started")
    /*client = new Influx.InfluxDB({
    host: 'localhost',
    port: 8086, // optional, default 8086
    protocol: 'http', // optional, default 'http'
    database: options.database
  })*/




  var obj = {}
  if (options.engine == 'propulsion.*.revolutions'){
    items.push(options.engine.replace(/\*/g, options.additional_info))
    engineSKPath = options.engine.replace(/\*/g, options.additional_info)
  }
  else if (options.engine == 'propulsion.*.state'){
    items.push(options.engine.replace(/\*/g, options.additional_info))
    engineSKPath = options.engine.replace(/\*/g, options.additional_info)
  }
  else if (options.engine == "AlwaysOff"){
    engineSKPath = "AlwaysOff"
  }
  debug("listening for " + util.inspect(items))
  debug("engineSKPath: " + engineSKPath)
  items.forEach(element => {
    obj[element] = true
  })

  shouldStore = function(path) {
    return typeof obj[path] != 'undefined'
  }




  app.signalk.on('delta', handleDelta)

  unsubscribes.push(Bacon.combineWith(function(awaDeg, aws, sog, cogDeg) {
    const cog = cogDeg / 180 * Math.PI
    const awa = awaDeg / 180 * Math.PI
    return [
      {
        measurement: 'environmentWindDirectionTrue',
        fields: {
          value: getTrueWindAngle(sog, aws, awa) + cog
        }
      }, {
        measurement: 'environmentWindSpeedTrue',
        fields: {
          value: getTrueWindSpeed(sog, aws, awa)
        }
      }
    ]
  }, [
    'environment.wind.angleApparent',
    'environment.wind.speedApparent',
    'navigation.speedOverGround',
    'navigation.courseOverGroundTrue']
    .map(app.streambundle.getSelfStream, app.streambundle))
    .changes()
    .debounceImmediate(200)
    .onValue(points => {
      /*client.writePoints(points, function(err, response) {
      if(err) {
      console.error(err)
      console.error(response)
    }
  })*/
}))
},
stop: function() {
  unsubscribes.forEach(f => f())
  items.length = items.length - 1
  engineSKPath = ""
  connection.end(function(err) {
    if (err) {
      debug('error disconnecting: ' + err.stack);
      return;
    }
  });
  app.signalk.removeListener('delta', handleDelta)
}
}
}

function getTrueWindAngle(speed, windSpeed, windAngle) {
  var apparentX = Math.cos(windAngle) * windSpeed;
  var apparentY = Math.sin(windAngle) * windSpeed;
  return Math.atan2(apparentY, -speed + apparentX);
};

function getTrueWindSpeed(speed, windSpeed, windAngle) {
  var apparentX = Math.cos(windAngle) * windSpeed;
  var apparentY = Math.sin(windAngle) * windSpeed;
  return Math.sqrt(Math.pow(apparentY, 2) + Math.pow(-speed + apparentX, 2));
};
