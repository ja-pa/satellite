'use strict';

/*
 * Collapse. From:
 * {domain -> {asn -> {ip -> #resolutions}}}
 *
 * To:
 * <outprefix>.asn-asn.json :  {domain -> {asn -> dominant asn}}
 */

var fs = require('fs');
var Q = require('q');
var chalk = require('chalk');
var es = require('event-stream');
var progress = require('progressbar-stream');
var asnmap = require('./asn_lookup');

if (!process.argv[6]) {
  console.error(chalk.red('Usage: asn_collapse-asn-asn.js <asn-aggregation> <lookup.json> <clusters.json> <clusters.ips.json> <outfile>'));
  process.exit(1);
}

var inFile = process.argv[2];
var lookupTable = asnmap.getMapSync(process.argv[3]);
var domainClusters = JSON.parse(fs.readFileSync(process.argv[4]));
var ipClusters = JSON.parse(fs.readFileSync(process.argv[5]));
var outFile = process.argv[6];
var clusterDomains = {};

domainClusters.forEach(function (cluster, idx) {
  if (!cluster) {
    return;
  }
  cluster.forEach(function (domain) {
    clusterDomains[domain] = idx;
  });
});

var rejects = 0;

function doDomain(line) {
  var asn_ip,
    domain,
    idx,
    ips,
    output = {};

  try {
    asn_ip = JSON.parse(line);
  } catch (e) {
    return;
  }
  domain = asn_ip.name;
  idx = clusterDomains[domain];
  ips = ipClusters['' + idx];
  if (!ips) {
    rejects += 1;
    return;
  }

  Object.keys(asn_ip).filter(function (asn) {
    return typeof asn_ip[asn] === 'object' && asn !== 'unknown';
  }).forEach(function (asn) {
    var mapped = {}, total = 0, max = {};
    Object.keys(asn_ip[asn]).filter(function (ip) {
      total += asn_ip[asn][ip];
      return ip !== 'empty' &&
          ip !== 'undefined' &&
          ip.indexOf(':') < 0 &&
          ips.indexOf('' + lookupTable.prefix(ip, 24)) > -1;
    }).forEach(function (ip) {
      var resolved_asn = lookupTable.lookup(ip);
      mapped[resolved_asn] = mapped[resolved_asn] || 0;
      mapped[resolved_asn] += asn_ip[asn][ip];
    });
    Object.keys(mapped).filter(function (asn) {
      return asn !== 'ZZ' && mapped[asn] > (total * 0.01);
    }).forEach(function (asn) {
      max[asn] = mapped[asn] / total;
    });
    if (Object.keys(max).length) {
      output[asn] = max;
    }
  });
  return JSON.stringify([domain, output]);
}

function doAll() {
  var total = fs.statSync(inFile).size || 0;

  console.log(chalk.blue('Starting'));
  return Q.Promise(function (resolve, reject) {
    fs.createReadStream(inFile)
      .pipe(progress({total: total}))
      .pipe(es.split())
      .pipe(es.mapSync(doDomain))
      .pipe(es.join('\n'))
      .pipe(fs.createWriteStream(outFile))
      .on('end', resolve)
      .on('error', reject);
  });
}

doAll().then(function () {
  console.warn('did not know ips for ' + rejects + 'domains');
});
