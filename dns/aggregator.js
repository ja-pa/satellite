/*jslint node:true*/
'use strict';

/*
 * Aggregate the directory of zmap scans into the .asn.json.
 * The resulting file is a json object on each line, of the format:
 *  domain -> {asn -> {ip -> %}}
 */

var Q = require('q');
var fs = require('fs');
var es = require('event-stream');
var chalk = require('chalk');
var asn = require('../asn_aggregation/asn_lookup');
var dns = require('native-dns-packet');
var ProgressBar = require('progress');
var progressBarStream = require('progressbar-stream');
var filter_ip = require('../util/config').getKey('local_ip');

if (!process.argv[4]) {
  console.error(chalk.red("Usage: asn_aggregator.js <rundir> <ASN table> <output file> [filter]"));
  process.exit(1);
}
var rundir = process.argv[2];
var asnTable = process.argv[3];
var outFile = process.argv[4];
var outFD = fs.openSync(outFile, 'ax');

var blfile = process.argv[5];

function parseDomainLine(map, blacklist, into, domains, line) {
  var parts = line.toString('ascii').split(','),
    theasn,
    thedomain,
    record,
    answers;
  if (parts.length !== 4 || blacklist[parts[0]]) {
    return;
  }
  thedomain = domains[parseInt(parts[1], 10)];
  if (thedomain === undefined) {
    return;
  }
  theasn = map.lookup(parts[0]);
  if (theasn === 'ZZ') {
    theasn = 'unknown';
  }
  try {
    record = dns.parse(new Buffer(parts[3], 'hex'));
    thedomain = record.question[0].name;

    answers = record.answer.filter(function (answer) {
      return answer.type === dns.consts.NAME_TO_QTYPE.A;
    });

    into[thedomain] = into[thedomain] || {};
    into[thedomain][theasn] = into[thedomain][theasn] || {};
    if (answers.length > 0) {
      answers.forEach(function (answer) {
        var ip = answer.address;
        into[thedomain][theasn][ip] = into[thedomain][theasn][ip] || 0;
        into[thedomain][theasn][ip] += 1;
      });
    } else {
      into[thedomain][theasn].empty = into[thedomain][theasn].empty || 0;
      into[thedomain][theasn].empty += 1;
    }
  } catch (e) {
    into[thedomain].failed += 1;
  }
}

// Read one csv file line by line.
function collapseSingle(map, blacklist, domains, file) {
  var into = {};
  domains.forEach(function (dom) {
    into[dom] = {
      name: dom,
      failed: 0
    };
  });

  return Q.Promise(function (resolve, reject) {
    fs.createReadStream(rundir + '/' + file)
      .pipe(es.split())
      .pipe(es.mapSync(parseDomainLine.bind({}, map, blacklist, into, domains)))
      .on('end', resolve)
      .on('error', reject);
  }).then(function () {
    var i;
    for (i = 0; i < domains.length; i += 1) {
      fs.writeSync(outFD, JSON.stringify(into[domains[i]]) + '\n');
      delete into[domains[i]];
    }
    return true;
  });
}

function collapseAll(asm, blacklist) {
  var base = new Q(),
    files, bar;

  files = fs.readdirSync(rundir).filter(function (file) {
    return /.csv$/.test(file);
  }).filter(function (file) {
    return fs.existsSync(rundir + '/' + file.replace('.csv', '.json'));
  });

  console.log(chalk.blue("Starting Aggregation of %d files"), files.length);
  bar = new ProgressBar(':bar :percent :eta', {total: files.length});

  files.forEach(function (file) {
    var domains = JSON.parse(fs.readFileSync(rundir + '/' + file.replace('.csv', '.json')));
    base = base.then(collapseSingle.bind({}, asm, blacklist, domains, file)).then(function () {
      bar.tick();
    });
  });

  return base;
}

function parseBlackList(into, line) {
  var parts = line.split(','),
    record;
  if (parts.length === 3) {
    try {
      record = dns.parse(new Buffer(parts[2], 'hex'));
    } catch (e) {
      return;
    }
    if (record.header.ra === 1 && record.answer.length > 0) {
      for (var i = 0; i < record.answer.length; i += 1) {
        if (record.answer[i].address === filter_ip) {
          return;
        }
      }
      into[parts[0]] = true;
    }
  }
}

function getBlackList() {
  return Q.Promise(function (resolve, reject) {
    if (!blfile) {
      resolve({});
    }

    var into = {},
      total = fs.statSync(blfile).size;

    console.log(chalk.blue("Generating Server Filter List"));
    fs.createReadStream(blfile)
      .pipe(progressBarStream({total: total}))
      .pipe(es.split())
      .pipe(es.mapSync(parseBlackList.bind({}, into)))
      .on('end', resolve.bind({}, into))
      .on('error', reject);
  });
}

Q.spread([asn.getMap(asnTable), getBlackList()], collapseAll)
  .then(function () {
    fs.closeSync(outFD);
    process.exit(0);
  }, function (err) {
    console.error(chalk.red(err));
  });
