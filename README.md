# Signal K to dynamic mySQL polar table

[![Greenkeeper badge](https://badges.greenkeeper.io/joabakk/signalk-polar.svg)](https://greenkeeper.io/)
Signal K Node server plugin to compare performance and write best performance to  [mySQL](https://www.mysql.com/), database.

This is the backend for https://github.com/joabakk/signalk-polar-graphing, to be able to visually see current performance compared to previous sailed performance. 

The plugin assumes that mySQL is installed and the database you specify exists. The database must be called 'polar' and the table can be created with the mySQL command:
```
CREATE TABLE `polar` (
  `id` int(11) unsigned NOT NULL AUTO_INCREMENT,
  `timestamp` text,
  `environmentWindSpeedApparent` float DEFAULT NULL,
  `environmentWindSpeedTrue` float DEFAULT NULL,
  `environmentWindAngleApparent` float DEFAULT NULL,
  `environmentWindAngleTrueGround` float DEFAULT NULL,
  `navigationSpeedThroughWater` float DEFAULT NULL,
  `performanceVelocityMadeGood` float DEFAULT NULL,
  `tack` text,
  `navigationRateOfTurn` float DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=65577 DEFAULT CHARSET=latin1;
```

