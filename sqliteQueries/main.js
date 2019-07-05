var sqlite3 = require('sqlite3')


function DB (dbFile) {
  console.log("connecting to " + dbFile)
  let db = new sqlite3.Database(dbFile, (error) => {
    if (error) {
      console.error(error.message);
      callback(err, error.message)
    }
    console.log('Connected to the SQlite database')
  })


  //Promise version
  this.selectPromise = function(query) {
    return new Promise(function(resolve, reject){
      db.get(query,function(err,rows){
        if(err) reject(err);
        resolve(rows);
      });
    });
  }

  this.getPromise = function(query) {
    return new Promise(function(resolve, reject){
      db.get(query,function(err,rows){
        if (err) {
                reject(err);
            } else {
                resolve(rows);
            }

      });
    });
  }

  this.allPromise = function(query) {
    return new Promise(function(resolve, reject){
      db.all(query,function(err,rows){
        if(err) {
          reject(err)
        } else {
        var response = []
        if(rows && rows.length>=1){
          rows.forEach((row, index) => {
            response.push(row)
          });
        }
        resolve(response);
      }
      });
    });
  }

  this.runPromise = function(query){
    return new Promise(function(resolve, reject){
      db.run(query, (err) => {
        if(err) reject(err);
        resolve('db run ok');
      })
    })
  }

}
module.exports = DB;
