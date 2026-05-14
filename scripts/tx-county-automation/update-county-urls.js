'use strict';
const fs = require('fs');
const path = require('path');

const COUNTIES_JSON = path.resolve(__dirname, '../../data/counties.json');
const data = JSON.parse(fs.readFileSync(COUNTIES_JSON, 'utf8'));
const TX = data.states.TX;

const ALL_UPDATES = {
  'Bandera':      { url: 'https://esearch.banderacounty.org/', platform: 'bis' },
  'Bastrop':      { url: 'https://esearch.bastropcad.org/', platform: 'bis' },
  'Bell':         { url: 'https://esearch.bellcad.org/', platform: 'bis' },
  'Bexar':        { url: 'https://bexar.acttax.com/act_webdev/bexar/index.jsp', platform: 'generic' },
  'Austin':       { url: 'https://esearch.austincad.org/', platform: 'bis' },
  'Bee':          { url: 'https://esearch.beecad.org/', platform: 'bis' },
  'Blanco':       { url: 'https://esearch.blancocad.com/', platform: 'bis' },
  'Borden':       { url: 'https://esearch.bordencad.org/', platform: 'bis' },
  'Brooks':       { url: 'https://esearch.brookscad.org/', platform: 'bis' },
  'Caldwell':     { url: 'https://esearch.caldwellcad.org/', platform: 'bis' },
  'Calhoun':      { url: 'https://esearch.calhouncad.org/', platform: 'bis' },
  'Callahan':     { url: 'https://esearch.callahancad.org/', platform: 'bis' },
  'Cameron':      { url: 'https://esearch.cameroncad.com/', platform: 'bis' },
  'Camp':         { url: 'https://esearch.campcad.org/', platform: 'bis' },
  'Cass':         { url: 'https://esearch.casscad.org/', platform: 'bis' },
  'Castro':       { url: 'https://esearch.castrocad.org/', platform: 'bis' },
  'Cherokee':     { url: 'https://esearch.cherokeecad.com/', platform: 'bis' },
  'Cochran':      { url: 'https://esearch.cochrancad.com/', platform: 'bis' },
  'Collin':       { url: 'https://esearch.collincad.org/', platform: 'bis' },
  'Colorado':     { url: 'https://esearch.coloradocad.org/', platform: 'bis' },
  'Comanche':     { url: 'https://esearch.comanchecad.org/', platform: 'bis' },
  'Concho':       { url: 'https://esearch.conchocad.org/', platform: 'bis' },
  'Coryell':      { url: 'https://esearch.coryellcad.org/', platform: 'bis' },
  'Deaf Smith':   { url: 'https://esearch.deafsmithcad.org/', platform: 'bis' },
  'Duval':        { url: 'https://esearch.duvalcad.org/', platform: 'bis' },
  'Edwards':      { url: 'https://esearch.edwardscad.org/', platform: 'bis' },
  'El Paso':      { url: 'https://esearch.epcad.org/', platform: 'bis' },
  'Falls':        { url: 'https://esearch.fallscad.org/', platform: 'bis' },
  'Fayette':      { url: 'https://esearch.fayettecad.org/', platform: 'bis' },
  'Fort Bend':    { url: 'https://esearch.fortbendcad.org/', platform: 'bis' },
  'Gaines':       { url: 'https://esearch.gainescad.org/', platform: 'bis' },
  'Galveston':    { url: 'https://esearch.galvestoncad.org/', platform: 'bis' },
  'Garza':        { url: 'https://esearch.garzacad.org/', platform: 'bis' },
  'Gillespie':    { url: 'https://esearch.gillespiecad.org/', platform: 'bis' },
  'Gray':         { url: 'https://esearch.graycad.org/', platform: 'bis' },
  'Hale':         { url: 'https://esearch.halecad.org/', platform: 'bis' },
  'Hartley':      { url: 'https://esearch.hartleycad.org/', platform: 'bis' },
  'Hays':         { url: 'https://esearch.hayscad.com/', platform: 'bis' },
  'Hill':         { url: 'https://esearch.hillcad.org/', platform: 'bis' },
  'Howard':       { url: 'https://esearch.howardcad.org/', platform: 'bis' },
  'Hudspeth':     { url: 'https://esearch.hudspethcad.org/', platform: 'bis' },
  'Hunt':         { url: 'https://esearch.huntcad.org/', platform: 'bis' },
  'Jasper':       { url: 'https://esearch.jaspercad.org/', platform: 'bis' },
  'Johnson':      { url: 'https://esearch.johnsoncad.com/', platform: 'bis' },
  'Kenedy':       { url: 'https://esearch.kenedycad.org/', platform: 'bis' },
  'Kerr':         { url: 'https://esearch.kerrcad.org/', platform: 'bis' },
  'Kimble':       { url: 'https://esearch.kimblecad.org/', platform: 'bis' },
  'Kinney':       { url: 'https://esearch.kinneycad.org/', platform: 'bis' },
  'Lamar':        { url: 'https://esearch.lamarcad.org/', platform: 'bis' },
  'Lamb':         { url: 'https://esearch.lambcad.org/', platform: 'bis' },
  'Lampasas':     { url: 'https://esearch.lampasascad.com/', platform: 'bis' },
  'Lavaca':       { url: 'https://esearch.lavacacad.com/', platform: 'bis' },
  'Liberty':      { url: 'https://esearch.libertycad.com/', platform: 'bis' },
  'Llano':        { url: 'https://esearch.llanocad.org/', platform: 'bis' },
  'Madison':      { url: 'https://esearch.madisoncad.org/', platform: 'bis' },
  'Mason':        { url: 'https://esearch.masoncad.org/', platform: 'bis' },
  'McMullen':     { url: 'https://esearch.mcmullencad.org/', platform: 'bis' },
  'Medina':       { url: 'https://esearch.medinacad.org/', platform: 'bis' },
  'Mills':        { url: 'https://esearch.millscad.org/', platform: 'bis' },
  'Mitchell':     { url: 'https://esearch.mitchellcad.org/', platform: 'bis' },
  'Moore':        { url: 'https://esearch.moorecad.org/', platform: 'bis' },
  'Newton':       { url: 'https://esearch.newtoncad.org/', platform: 'bis' },
  'Nueces':       { url: 'https://esearch.nuecescad.com/', platform: 'bis' },
  'Oldham':       { url: 'https://esearch.oldhamcad.org/', platform: 'bis' },
  'Parmer':       { url: 'https://esearch.parmercad.org/', platform: 'bis' },
  'Polk':         { url: 'https://esearch.polkcad.org/', platform: 'bis' },
  'Presidio':     { url: 'https://esearch.presidiocad.org/', platform: 'bis' },
  'Rains':        { url: 'https://esearch.rainscad.org/', platform: 'bis' },
  'Real':         { url: 'https://esearch.realcad.org/', platform: 'bis' },
  'Robertson':    { url: 'https://esearch.robertsoncad.com/', platform: 'bis' },
  'Schleicher':   { url: 'https://esearch.schleichercad.org/', platform: 'bis' },
  'Shackelford':  { url: 'https://esearch.shackelfordcad.com/', platform: 'bis' },
  'Shelby':       { url: 'https://esearch.shelbycad.com/', platform: 'bis' },
  'Starr':        { url: 'https://esearch.starrcad.org/', platform: 'bis' },
  'Sutton':       { url: 'https://esearch.suttoncad.com/', platform: 'bis' },
  'Tarrant':      { url: 'https://esearch.tarrantcad.org/', platform: 'bis' },
  'Terrell':      { url: 'https://esearch.terrellcad.org/', platform: 'bis' },
  'Throckmorton': { url: 'https://esearch.throckmortoncad.org/', platform: 'bis' },
  'Uvalde':       { url: 'https://esearch.uvaldecad.org/', platform: 'bis' },
  'Victoria':     { url: 'https://esearch.victoriacad.org/', platform: 'bis' },
  'Walker':       { url: 'https://esearch.walkercad.org/', platform: 'bis' },
  'Waller':       { url: 'https://esearch.wallercad.org/', platform: 'bis' },
  'Washington':   { url: 'https://esearch.washingtoncad.org/', platform: 'bis' },
  'Willacy':      { url: 'https://esearch.willacycad.org/', platform: 'bis' },
  'Williamson':   { url: 'https://esearch.williamsoncad.org/', platform: 'bis' },
  'Yoakum':       { url: 'https://esearch.yoakumcad.org/', platform: 'bis' },
  'Young':        { url: 'https://esearch.youngcad.org/', platform: 'bis' },
  'Zapata':       { url: 'https://esearch.zapatacad.com/', platform: 'bis' },
  'Zavala':       { url: 'https://esearch.zavalacad.com/', platform: 'bis' },
  // Was updated individually but lost in bulk overwrite
  'Atascosa':     { url: 'https://esearch.atascosacad.com/', platform: 'bis' },
  'Bosque':       { url: 'https://esearch.bosquecad.com/', platform: 'bis' },
  'Bowie':        { url: 'https://esearch.bowiecad.org/', platform: 'bis' },
  'Brazos':       { url: 'https://esearch.brazoscad.org/', platform: 'bis' },
  // No-url counties now with real URLs
  'Navarro':      { url: 'http://navarrocad.com/', platform: 'generic' },
  'Potter':       { url: 'https://www.pottercountytax.com/search', platform: 'generic' },
  'Randall':      { url: 'https://taxpayer.randallcounty.com/taxweb/', platform: 'generic' },
  'Rockwall':     { url: 'https://www.rockwallcad.com/', platform: 'generic' },
  'Wichita':      { url: 'https://esearch.wadtx.com', platform: 'bis' },
  'Wise':         { url: 'https://esearch.wise-cad.com/', platform: 'bis' },
};

let updated = 0;
for (const [county, vals] of Object.entries(ALL_UPDATES)) {
  if (TX[county]) {
    TX[county].url = vals.url;
    TX[county].platform = vals.platform;
    TX[county].lastVerified = '2026-05-15';
    updated++;
  } else {
    console.log('NOT FOUND:', county);
  }
}

data.lastUpdated = '2026-05-15';
fs.writeFileSync(COUNTIES_JSON, JSON.stringify(data, null, 2), 'utf8');
console.log('Updated:', updated, 'counties in counties.json');
// Spot-check
const check = ['Bandera','Bastrop','Bell','Bexar','Austin','Caldwell','Wichita','Tarrant'];
check.forEach(c => console.log(' ', c, ':', TX[c].url));
