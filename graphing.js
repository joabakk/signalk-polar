var Highcharts = require('highcharts')
require('highcharts/highcharts-more.js')(Highcharts)
require('highcharts/modules/exporting')(Highcharts);

var tableIndexMax = 2 //port, starboard and combined hard coded
const tableData = {}
var vesselName
var tableOverview = []


function getVesselName(){
  (async() => {
    try {
      var response = await fetch("/signalk/v1/api/vessels/self/name");
      vesselName = await response.json();
      return vesselName
    } catch (e) {
      //console.log("Error fetching boat name")
    }
  })()
  return vesselName
}
//getVesselName()

function getTables(err, response){ // get user entered polars
  $.getJSON("/plugins/signalk-polar/polarTables", function(json) {
    var polars= Object.entries(Object.values(json.polars))
    console.log(polars)
    polars.forEach((polar)=> {
      console.log(polar[1])

        tableIndexMax ++

        var tableNameMain = polar[1].name
        tableOverview.push(tableNameMain)
        var tableDescription = polar[1].description
        console.log(tableNameMain)
        polar[1].windData.forEach(function(entry){//for each wind speed
          console.log(entry)
          var windSpeed = Math.abs(entry['trueWindSpeed']);
          var tableName = tableNameMain + "_" + windSpeed
          const polarArray = []
          var windAngles = entry.angleData.map(function(x) {
            return x[0];
          });
          console.log(windAngles)
          var boatSpeeds = entry.angleData.map(function(x) {
            return x[1];
          });
          for (index = 0; index < windAngles.length; ++index) {
            tableData[tableName] = polarArray
            var windDeg = windAngles[index]/Math.PI*180
            var speedKnots
            if(boatSpeeds[index]==null){
              speedKnots = null
            }
            else {
              speedKnots = boatSpeeds[index]/1852*3600
            }
            var item = [windDeg, speedKnots]
            polarArray.push(item)
          }
        })
    })

  })


  if(err){
    console.log("error: " + err)
  } else {

    return tableData
  }

}


//to be updated once every second?:
var current = [];
//updated only on refresh:
var portPolar = [];
var stbPolar = [];
var polarCombined = [];

var tackAngle
var reachAngle

var windSpeed = 5.8;
var windRange = 0.2;

var nightmode = false;

function getWind() {
  (async() => {
    try {
      var response = await fetch("/signalk/v1/api/vessels/self/environment/wind/speedOverGround");
      windSpeedTemp = await response.json();
      windSpeed = parseFloat(windSpeedTemp.value)
      //console.log("wind speed: " + windSpeed)
    } catch (e) {
      //console.log("Error fetching wind speed")
    }
  })()
  return windSpeed;
};


$(function () {

  Highcharts.setOptions({
    global : {
      useUTC : false
    }
  });

  $('#container').highcharts({

    chart: {
      polar: true,
      animation: false,//to remove flickering on axis labels
      //borderWidth: 2,
      marginLeft: 50,
      //marginTop: 100,
      events: {
        load: function () {
          var chart = $('#container').highcharts();
          var plotLine = this.xAxis.plotLines;

          // Get user defined tables from signalk-polar API

          var userTables = getTables()

          vesselName = getVesselName()

          setTimeout(function () {
            chart.setTitle({
              align: 'left',
              text: vesselName + ' live polar chart'
            });

            //console.log("max index: " + tableIndexMax)
            //console.log("tableData: " + JSON.stringify(userTables, null, 4));
            var iter = 2
            Object.keys(userTables).forEach(function(key) {
              //console.log(key, userTables[key])
              chart.addSeries({
                type: 'line',
                name: key.replace(/_/g, " ") + ' m/s',
                dashStyle: 'shortdashdot',
                data: userTables[key],
                visible: false,
                connectEnds: false,
                connectNulls: false
              })
            })
          }, 500)

          // set up the updating of the plotlines each second

          setInterval(function () {

            chart = $('#container').highcharts();
            (async() => {
              chart.xAxis[0].removePlotLine('tackS');
              chart.xAxis[0].removePlotLine('tackP');
              chart.xAxis[0].removePlotLine('reachS');
              chart.xAxis[0].removePlotLine('reachP');
              try {
                var response = await fetch("/signalk/v1/api/vessels/self/performance/beatAngle/");
                var x = await response.json()
                var y = parseFloat(x.value)
                tackAngle = Math.abs(y/Math.PI*180);
                //console.log("tackAngle " + tackAngle)
                chart.xAxis[0].addPlotLine({
                  color: 'red', // Color value
                  dashStyle: 'shortdashdot', // Style of the plot line. Default to solid
                  value: tackAngle,//getTarget().Tack, // Value of where the line will appear
                  width: 2, // Width of the line
                  id: 'tackS'
                });
                chart.xAxis[0].addPlotLine({
                  color: 'red', // Color value
                  dashStyle: 'shortdashdot', // Style of the plot line. Default to solid
                  value: -tackAngle,//getTarget().Tack, // Value of where the line will appear
                  width: 2, // Width of the line
                  id: 'tackP',
                  label: {
                    text: tackAngle.toFixed(2)+ '°',
                    verticalAlign: 'center',
                    textAlign: 'right',
                    rotation: 90-tackAngle,
                    //y: 12,
                    x: 0//120
                  }
                });

                response = await fetch("/signalk/v1/api/vessels/self/performance/gybeAngle");
                var x = await response.json()
                var y = parseFloat(x.value)
                reachAngle = Math.abs(y/Math.PI*180);
                //console.log("reachAngle " + reachAngle)
                chart.xAxis[0].addPlotLine({
                  color: 'red', // Color value
                  dashStyle: 'shortdashdot', // Style of the plot line. Default to solid
                  value: reachAngle,//getTarget().Tack, // Value of where the line will appear
                  width: 2, // Width of the line
                  id: 'reachS'
                });
                chart.xAxis[0].addPlotLine({
                  color: 'red', // Color value
                  dashStyle: 'shortdashdot', // Style of the plot line. Default to solid
                  value: -reachAngle,//getTarget().Tack, // Value of where the line will appear
                  width: 2, // Width of the line
                  id: 'reachP',
                  label: {
                    text: reachAngle.toFixed(2)+ '°',
                    verticalAlign: 'right',
                    textAlign: 'right',
                    rotation: 90-reachAngle,//rotation: reachAngle-90,
                    //y: 12,
                    x: 0//20
                  }
                });

              }
              catch (e) {
                //console.log("Error fetching beat and gybe angles")
              }



            })();
          }, 1000);
          // set up the updating of the chart each second

          var series = this.series[tableIndexMax + 1];
          var seriess = this.series;

          setInterval(function () {
            try {
              var subTitle = getWind().toFixed(2)+' +/-'+windRange+' m/s';
              //alert(subTitle);
              chart.setTitle(null, {text: subTitle});
            } catch (e) {
              //console.log("Error fetching wind speed")
            }

            (async() => {
              try {
                var response = await fetch("/signalk/v1/api/vessels/self/environment/wind/angleTrueGround");
                var xf = await response.json()
                var x = parseFloat(xf.value)
                var xDeg = x/Math.PI*180 //future -180 to 180 deg
                response = await fetch("/signalk/v1/api/vessels/self/navigation/speedThroughWater");
                var yf = await response.json()
                var y = parseFloat(yf.value)
                var yKnots = y/1852*3600;
                //console.log("current dot:" + xDeg + " " + yKnots);
                series.addPoint([xDeg, yKnots], true, true);

              } catch (e) {
                //console.log("Error fetching wind angle and boat speed")
              }
            })();


          }, 1000);

          //update current polar each second
          /*
          setInterval(function () {
            var chart = $('#container').highcharts(),
            options = chart.options;
            $.getJSON("/plugins/signalk-polar/polarTable/?windspeed=" + windSpeed + "&interval=" + windRange, function (json) {
              portPolar.length = 0;
              stbPolar.length = 0;
              polarCombined.length = 0;
              json.forEach(function(entry) {
                if(entry['angle'] > 0){
                  var windDeg = (entry['angle']/Math.PI*180);
                  var speedKnots = entry['speed']/1852*3600;
                  console.log(windDeg + ',' + speedKnots);
                  var polarItem = [windDeg , speedKnots];
                  stbPolar.push(polarItem); //positive angles
                }

                if(entry['angle'] < 0){
                  var windDeg = (entry['angle']/Math.PI*180);
                  var speedKnots = entry['speed']/1852*3600;
                  console.log(windDeg + ',' + speedKnots);
                  var polarItem = [-windDeg , speedKnots];
                  portPolar.push(polarItem); //negative angles
                }

                var windDeg = Math.abs(entry['angle']/Math.PI*180);
                var speedKnots = entry['speed']/1852*3600;
                var polarItem = [windDeg , speedKnots];
                polarCombined.push(polarItem); //combined port and starboard angles

              });
              chart.series[0].setData(portPolar,true);
              chart.series[1].setData(stbPolar,true);
              chart.series[2].setData(polarCombined,true);

              options = chart.options;
            });

          }, 1000);
          */



        }
      }
    },

    legend: {
      verticalAlign: "middle",
      align: "right",
      layout: "vertical"
    },

    pane: {
      center: ["50%", "50%"],
      startAngle: -180,
      endAngle: 180
    },

    xAxis: {
      tickInterval: 45,
      min: -180,
      max: 180,
      labels: {
        formatter: function () {
          return this.value + '°';
        }
      },
      plotLines: [{
        color: 'red', // Color value
        dashStyle: 'shortdashdot', // Style of the plot line. Default to solid
        value: tackAngle,//getTarget().Tack, // Value of where the line will appear
        width: 2, // Width of the line
        id: 'tack',
        label: {
          text: 'Target tack '+tackAngle+ '°',
          verticalAlign: 'center',
          textAlign: 'center',
          rotation: tackAngle-90,
          x: 90
        }
      },  {
        color: 'red', // Color value
        dashStyle: 'shortdashdot', // Style of the plot line. Default to solid
        value: reachAngle, // Value of where the line will appear
        width: 2, // Width of the line
        id: 'reach', //see http://www.highcharts.com/docs/chart-concepts/plot-bands-and-plot-lines for dynamically updating
        label: {
          text: 'Target reach '+reachAngle+ '°',
          verticalAlign: 'right',
          textAlign: 'top',
          rotation: reachAngle-90,
          x: 20
        }
      }]
    },

    yAxis: {
      min: 0
    },

    plotOptions: {
      series: {
        pointStart: 0,
        pointInterval: 45,
        enableMouseTracking: false,
        connectNulls: false

      },
      column: {
        pointPadding: 0,
        groupPadding: 0
      },
      spline: { /* or line, area, series, areaspline etc.*/
        marker: {
          enabled: false
        },
        connectNulls: false
      },
      scatter: {
        dataLabels: {
          enabled: true,
          format: '{y:.2f}kn , {x:.1f}°'
        },
        marker: {
          //fillColor: 'transparent',
          lineWidth: 2,
          symbol: 'circle',
          lineColor: null
        }
      }
    },
    series: [{
      type: 'line',
      name: 'Port',
      color: 'red',
      data: portPolar,
      visible: false,
      connectEnds: false,
      connectNulls: false,
      turboThreshold: 0
    },
    {
      type: 'line',
      name: 'Starboard',
      color: 'green',
      data: stbPolar,
      visible: false,
      connectEnds: false,
      connectNulls: false,
      turboThreshold: 0
    },
    {
      type: 'line',
      name: 'Combined port & stbd',
      lineWidth: 5,
      //color: 'blue',
      data: polarCombined,
      connectEnds: false,
      connectNulls: false,
      turboThreshold: 0
    },
    {
      type: 'scatter',
      name: 'Current performance',
      color: 'orange',
      data: [current],
    }]


  });

  $('#toggle').click(function () {
    var chart = $('#container').highcharts(),
    options = chart.options;

    options.chart.polar = !options.chart.polar;

    $('#container').highcharts(options);
  });

});
