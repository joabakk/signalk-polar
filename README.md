# Signal K to dynamic mySQL polar table

[![Greenkeeper badge](https://badges.greenkeeper.io/joabakk/signalk-polar.svg)](https://greenkeeper.io/)
Signal K Node server plugin to compare performance and write best performance to  [mySQL](https://www.mysql.com/), database.

This is the backend for https://github.com/joabakk/signalk-polar-graphing, to be able to visually see current performance compared to previous sailed performance. 

The plugin assumes that mySQL is installed and the database you specify exists. The database must be called 'polar' and the table can be created with the mySQL command:
```
CREATE TABLE `polar` (
  `id` int(11) unsigned NOT NULL AUTO_INCREMENT,
  `timestamp` text,
  `environmentWindSpeedApparent` double DEFAULT NULL,
  `environmentWindSpeedTrue` double DEFAULT NULL,
  `environmentWindAngleApparent` double DEFAULT NULL,
  `environmentWindAngleTrueGround` double DEFAULT NULL,
  `navigationSpeedThroughWater` double DEFAULT NULL,
  `performanceVelocityMadeGood` double DEFAULT NULL,
  `tack` text,
  `navigationRateOfTurn` double DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=309 DEFAULT CHARSET=latin1;
```

And create a user name and password if you do not want to use the root password to mySQL
