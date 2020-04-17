# Signal K to dynamic sqlite polar table


Signal K Node server plugin to compare performance and write best performance to  [sqlite3](https://www.sqlite.org/), database.

This is now both a backend plugin and a webapp with polar graphing, to be able to visually see current performance compared to previous sailed performance.

If the plugin stops, re-enable it and look for strange strings in the polar tables in the plugin config view.

As this plugin stores polars in a SQLite database structure, in order to delete unused polar tables, use the `/plugins/signalk-polar/listPolarTables?uuid=` query.

![image](https://user-images.githubusercontent.com/2553029/79595779-be7ac280-80df-11ea-8da2-a4766e4915b2.png)
