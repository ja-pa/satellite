'use strict';

/**
 * Filter hosts to the intersection of two runs.
 * Used to only query IPs which are long-lived.
 * Usage:
 * node historicfilter.js <hosts.txt> <old-hosts.txt> <intersection.txt>
 */

var fs = require('fs');
var ip_utils = require('../util/ip_utils');
var mask = require('../util/mask').newMask(256*256*256);

console.log('Loading Files.');

var linesNow = fs.readFileSync(process.argv[2]).toString();
var linesThen = fs.readFileSync(process.argv[3]).toString();

console.log('Parsing Whitelist');
linesThen.split('\n').forEach(function (line) {
  var ip = line.split('/')[0];
  if (ip) {
    mask.set(ip_utils.getClassC(ip)/256);
  }
});

console.log('Filtering Whitelist');
var ln = linesNow.split('\n');
var good = ln.filter(function (line) {
  var ip = line.split('/')[0];
  return ip && mask.get(ip_utils.getClassC(ip)/256);
});

console.log('Intersection is ' + (good.length / ln.length * 100) + '% original.');

fs.writeFileSync(process.argv[4], good.join('\n'));
console.log('Done');
process.exit(0);
