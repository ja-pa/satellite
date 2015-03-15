/*
 * Aggregate a study by ASN#
 * Given an uncompressed study directory, the data is compressed to a denser mapping of
 * domain -> {asn -> {ip -> %}}
 */

var Q = require('q');
var fs = require('fs');
var es = require('event-stream')
var chalk = require('chalk')
var asn = require('./asn_aggregation/asn_lookup')
var dns = require('native-dns-packet');

if (process.argv[4]) {
  console.error(chalk.red("Usage: asn_aggregator.js <rundir> <ASN table> <output file.>"));
  process.exit(1);
}
var rundir = process.argv[2];
var asnTable = process.argv[3];
var outFile = process.argv[4];

function parseDomainLine(map, into, domain, line) {
  var parts = line.toString('ascii').split(',');
  if (parts.length !== 3) {
    return;
  }
  var theasn = map.classC(parts[0]);
  var record;
  try {
    record = dns.parse(new Buffer(parts[2], 'hex'));
    if (!into[theasn]) {
      into[theasn] = {};
    }
    if (record.answer.length > 0) {
      record.answer.forEach(function(answer) {
        var ip = answer.address;
        if (!into[theasn][ip]) {
          into[theasn][ip] = 1;
        } else {
          into[theasn][ip] += 1;
        }
      });
    } else {
      if (!into[theasn].empty) {
        into[theasn].empty = 0;
      }
      into[theasn].empty += 1;
    }
  } catch(e) {
    into.failed += 1;
    return;
  }
}

// Read one csv file line by line.
function collapseSingle(map, domain, file) {
  var into = {
    failed: 0
  };
  if (fs.existsSync(rundir + '/' + file + '.asn.json')) {
    return Q(0);
  }

  return Q.Promise(function(resolve, reject) {
    fs.createReadStream(rundir + '/' + file)
      .pipe(es.split())
      .pipe(es.mapSync(parseDomainLine.bind({}, map, into, domain)))
      .on('end', resolve)
      .on('error', reject);
  }).then(function(m) {
    fs.writeFileSync(rundir + '/' + file + '.asn.json', JSON.stringify(into));
    delete into;
    return true;
  });
}

function collapseAll(asm) {
  var files = fs.readdirSync(rundir);
  console.log(chalk.blue("Starting Aggregation of %d domains"), files.length);
  return Q.Promise(function(resolve, reject) {
    var base = Q(0);
    var n = 0;
    var allFiles = [];
    files.forEach(function(domain) {
      if (domain.indexOf('.csv') < 0 || domain.indexOf('asn.json') > 0) {
        return;
      }
      allFiles.push(domain);
      var dn = domain.split('.csv')[0];
      n += 1;
      if (n%100 === 0) {
        base.then(function() {
          console.log(chalk.blue("."));
        })
      }
      if (n%1000 === 0) {
        base.then(function(x) {
          console.log(chalk.green(x));
        }.bind({},n))
      }
      base = base.then(collapseSingle.bind({}, asm, dn, domain));
    });
    return base.then(function() {
      console.log(chalk.green('Done.'));
      return allFiles;
    }).then(resolve, reject);
  });
}

var queue;
function writeMap(files) {
  console.log(chalk.blue('Writing Compiled Map.'));
  var stream = fs.createWriteStream(outFile);
  return Q.Promise(function(resolve, reject) {
    stream.on('finish', resolve);
    stream.on('error', reject);

    stream.write("{\"length\":" + files.length);

    queue = files;
    aggregateMap(stream);
  }).then(function() {
    console.log(chalk.green('Done.'));
    console.log(chalk.blue('Cleaning Up.'));
    var all = fs.readdirSync(rundir);
    all.forEach(function(file) {
      if (file.indexOf('.asn.json') > 0) {
        fs.unlinkSync(rundir + '/' + file);
      }
    });
  });
}

function aggregateMap(stream) {
  if (queue.length) {
    var next = queue.pop();
    var domain = next.split('.csv')[0];
    stream.write(",\"" + domain + "\":");
    if(stream.write(fs.readFileSync(rundir + '/' + next + '.asn.json'))) {
      process.nextTick(aggregateMap.bind({}, stream));
    } else {
      stream.once('drain', aggregateMap.bind({}, stream));
    }
  } else {
    stream.write("}");
    stream.end();
  }
}

asn.getMap(asnTable)
.then(collapseAll)
.then(writeMap)
.then(function() {
  console.log(chalk.green('Done'));
  process.exit(0);
},function(err) {
  console.error(chalk.red(err));
});
