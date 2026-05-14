'use strict';
const fs = require('fs');
const path = require('path');

const COUNTIES_JSON = path.resolve(__dirname, '../../data/counties.json');
const data = JSON.parse(fs.readFileSync(COUNTIES_JSON, 'utf8'));
const TX = data.states.TX;

// ─── All URL updates ────────────────────────────────────────────────────────
// Rules:
//   - esearch.{county}cad.org/  are real BIS portals (or may redirect to one)
//   - If Netronline shows a specific platform URL, use that instead
//   - Confirmed working URLs take priority
// ────────────────────────────────────────────────────────────────────────────

const ALL_UPDATES = {
  // ── A ────────────────────────────────────────────────────────────────────
  'Atascosa':     { url: 'https://esearch.atascosacad.com/', platform: 'bis' },
  'Austin':       { url: 'https://esearch.austincad.org/', platform: 'bis' },
  // ── B ────────────────────────────────────────────────────────────────────
  'Bandera':      { url: 'https://esearch.banderacounty.org/', platform: 'bis' },
  'Bastrop':      { url: 'https://esearch.bastropcad.org/', platform: 'bis' },
  'Bee':          { url: 'https://esearch.beecad.org/', platform: 'bis' },
  'Bell':         { url: 'https://esearch.bellcad.org/', platform: 'bis' },
  'Bexar':        { url: 'https://bcad.org/propertysearch/', platform: 'generic' },
  'Blanco':       { url: 'https://esearch.blancocad.com/', platform: 'bis' },
  'Borden':       { url: 'https://esearch.bordencad.org/', platform: 'bis' },
  // Bosque: tax office has its own search portal (confirmed by Netronline)
  'Bosque':       { url: 'https://www.bosquecountytaxoffice.com/search', platform: 'generic' },
  // Bowie: esearch redirects to the actual property search
  'Bowie':        { url: 'https://www.bowieappraisal.com/property-search', platform: 'generic' },
  'Brazos':       { url: 'https://esearch.brazoscad.org/', platform: 'bis' },
  'Brooks':       { url: 'https://esearch.brookscad.org/', platform: 'bis' },
  'Burleson':     { url: 'https://esearch.burlesonappraisal.com/', platform: 'bis' },
  // ── C ────────────────────────────────────────────────────────────────────
  'Caldwell':     { url: 'https://esearch.caldwellcad.org/', platform: 'bis' },
  'Calhoun':      { url: 'https://esearch.calhouncad.org/', platform: 'bis' },
  // Callahan: esearch redirects to ISW DataClient portal
  'Callahan':     { url: 'http://iswdataclient.azurewebsites.net/webindex.aspx?dbkey=callahancad&time=201601191609003', platform: 'isw' },
  // Cameron: uses ProdigyCAD (confirmed partial working)
  'Cameron':      { url: 'https://cameron.prodigycad.com/property-search', platform: 'prodigycad' },
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
  // ── D ────────────────────────────────────────────────────────────────────
  'Deaf Smith':   { url: 'https://esearch.deafsmithcad.org/', platform: 'bis' },
  'Duval':        { url: 'https://esearch.duvalcad.org/', platform: 'bis' },
  // ── E ────────────────────────────────────────────────────────────────────
  'Edwards':      { url: 'https://esearch.edwardscad.org/', platform: 'bis' },
  'El Paso':      { url: 'https://esearch.epcad.org/', platform: 'bis' },
  // ── F ────────────────────────────────────────────────────────────────────
  // Falls: correct TLD is .net not .org (Netronline confirmed)
  'Falls':        { url: 'https://esearch.fallscad.net/', platform: 'bis' },
  'Fayette':      { url: 'https://esearch.fayettecad.org/', platform: 'bis' },
  'Fort Bend':    { url: 'https://esearch.fortbendcad.org/', platform: 'bis' },
  // ── G ────────────────────────────────────────────────────────────────────
  'Gaines':       { url: 'https://esearch.gainescad.org/', platform: 'bis' },
  'Galveston':    { url: 'https://esearch.galvestoncad.org/', platform: 'bis' },
  'Garza':        { url: 'https://esearch.garzacad.org/', platform: 'bis' },
  'Gillespie':    { url: 'https://esearch.gillespiecad.org/', platform: 'bis' },
  'Gray':         { url: 'https://esearch.graycad.org/', platform: 'bis' },
  // ── H ────────────────────────────────────────────────────────────────────
  'Hale':         { url: 'https://esearch.halecad.org/', platform: 'bis' },
  // Hartley: ISW DataClient portal (Netronline confirmed)
  'Hartley':      { url: 'http://iswdataclient.azurewebsites.net/webindex.aspx?dbkey=hartleycad&time=201601191610049', platform: 'isw' },
  'Hays':         { url: 'https://esearch.hayscad.com/', platform: 'bis' },
  'Hill':         { url: 'https://esearch.hillcad.org/', platform: 'bis' },
  // Howard: BIS portal via bisconsultants.com domain (Netronline confirmed)
  'Howard':       { url: 'http://gis.bisconsultants.com/howardcad/', platform: 'bis' },
  'Hudspeth':     { url: 'https://esearch.hudspethcad.org/', platform: 'bis' },
  'Hunt':         { url: 'https://esearch.huntcad.org/', platform: 'bis' },
  // ── J ────────────────────────────────────────────────────────────────────
  'Jasper':       { url: 'https://esearch.jaspercad.org/', platform: 'bis' },
  'Johnson':      { url: 'https://esearch.johnsoncad.com/', platform: 'bis' },
  // ── K ────────────────────────────────────────────────────────────────────
  'Kenedy':       { url: 'https://esearch.kenedycad.org/', platform: 'bis' },
  'Kerr':         { url: 'https://esearch.kerrcad.org/', platform: 'bis' },
  'Kimble':       { url: 'https://esearch.kimblecad.org/', platform: 'bis' },
  'Kinney':       { url: 'https://esearch.kinneycad.org/', platform: 'bis' },
  // ── L ────────────────────────────────────────────────────────────────────
  'Lamar':        { url: 'https://esearch.lamarcad.org/', platform: 'bis' },
  'Lamb':         { url: 'https://esearch.lambcad.org/', platform: 'bis' },
  'Lampasas':     { url: 'https://esearch.lampasascad.com/', platform: 'bis' },
  'Lavaca':       { url: 'https://esearch.lavacacad.com/', platform: 'bis' },
  // Liberty: TrueAutomation/ProAccess portal (Netronline confirmed)
  'Liberty':      { url: 'https://propaccess.trueautomation.com/ClientDB/PropertySearch.aspx?cid=8', platform: 'trueautomation' },
  'Llano':        { url: 'https://esearch.llanocad.org/', platform: 'bis' },
  // ── M ────────────────────────────────────────────────────────────────────
  'Madison':      { url: 'https://esearch.madisoncad.org/', platform: 'bis' },
  'Mason':        { url: 'https://esearch.masoncad.org/', platform: 'bis' },
  'McMullen':     { url: 'https://esearch.mcmullencad.org/', platform: 'bis' },
  'Medina':       { url: 'https://esearch.medinacad.org/', platform: 'bis' },
  'Mills':        { url: 'https://esearch.millscad.org/', platform: 'bis' },
  'Mitchell':     { url: 'https://esearch.mitchellcad.org/', platform: 'bis' },
  'Moore':        { url: 'https://esearch.moorecad.org/', platform: 'bis' },
  // ── N ────────────────────────────────────────────────────────────────────
  'Newton':       { url: 'https://esearch.newtoncad.org/', platform: 'bis' },
  'Nueces':       { url: 'https://esearch.nuecescad.com/', platform: 'bis' },
  // ── O ────────────────────────────────────────────────────────────────────
  'Oldham':       { url: 'https://esearch.oldhamcad.org/', platform: 'bis' },
  // ── P ────────────────────────────────────────────────────────────────────
  'Parmer':       { url: 'https://esearch.parmercad.org/', platform: 'bis' },
  'Polk':         { url: 'https://esearch.polkcad.org/', platform: 'bis' },
  'Presidio':     { url: 'https://esearch.presidiocad.org/', platform: 'bis' },
  // ── R ────────────────────────────────────────────────────────────────────
  'Rains':        { url: 'https://esearch.rainscad.org/', platform: 'bis' },
  'Real':         { url: 'https://esearch.realcad.org/', platform: 'bis' },
  'Robertson':    { url: 'https://esearch.robertsoncad.com/', platform: 'bis' },
  // ── S ────────────────────────────────────────────────────────────────────
  'Schleicher':   { url: 'https://esearch.schleichercad.org/', platform: 'bis' },
  'Shackelford':  { url: 'https://esearch.shackelfordcad.com/', platform: 'bis' },
  'Shelby':       { url: 'https://esearch.shelbycad.com/', platform: 'bis' },
  'Starr':        { url: 'https://esearch.starrcad.org/', platform: 'bis' },
  'Sutton':       { url: 'https://esearch.suttoncad.com/', platform: 'bis' },
  // ── T ────────────────────────────────────────────────────────────────────
  'Tarrant':      { url: 'https://esearch.tarrantcad.org/', platform: 'bis' },
  'Terrell':      { url: 'https://esearch.terrellcad.org/', platform: 'bis' },
  'Throckmorton': { url: 'https://esearch.throckmortoncad.org/', platform: 'bis' },
  // ── U ────────────────────────────────────────────────────────────────────
  'Uvalde':       { url: 'https://esearch.uvaldecad.org/', platform: 'bis' },
  // ── V ────────────────────────────────────────────────────────────────────
  'Victoria':     { url: 'https://esearch.victoriacad.org/', platform: 'bis' },
  // ── W ────────────────────────────────────────────────────────────────────
  'Walker':       { url: 'https://esearch.walkercad.org/', platform: 'bis' },
  'Waller':       { url: 'https://esearch.wallercad.org/', platform: 'bis' },
  'Washington':   { url: 'https://esearch.washingtoncad.org/', platform: 'bis' },
  'Willacy':      { url: 'https://esearch.willacycad.org/', platform: 'bis' },
  'Williamson':   { url: 'https://esearch.williamsoncad.org/', platform: 'bis' },
  // ── Y ────────────────────────────────────────────────────────────────────
  'Young':        { url: 'https://esearch.youngcad.org/', platform: 'bis' },
  // ── Z ────────────────────────────────────────────────────────────────────
  // Zapata: PublicSearch portal (Netronline confirmed)
  'Zapata':       { url: 'https://zapata.tx.publicsearch.us/', platform: 'publicportal' },
  'Zavala':       { url: 'https://esearch.zavalacad.com/', platform: 'bis' },
  // ── Previously updated in other commits ──────────────────────────────────
  'Atascosa':     { url: 'https://esearch.atascosacad.com/', platform: 'bis' },
  'Bosque':       { url: 'https://www.bosquecountytaxoffice.com/search', platform: 'generic' },
  'Bowie':        { url: 'https://www.bowieappraisal.com/property-search', platform: 'generic' },
  'Brazos':       { url: 'https://esearch.brazoscad.org/', platform: 'bis' },
  'Navarro':      { url: 'http://navarrocad.com/', platform: 'generic' },
  'Potter':       { url: 'https://www.pottercountytax.com/search', platform: 'generic' },
  'Randall':      { url: 'https://taxpayer.randallcounty.com/taxweb/', platform: 'generic' },
  'Rockwall':     { url: 'https://www.rockwallcad.com/', platform: 'generic' },
  'Wichita':      { url: 'https://esearch.wadtx.com', platform: 'bis' },
  'Wise':         { url: 'https://esearch.wise-cad.com/', platform: 'bis' },
  'Yoakum':       { url: 'https://esearch.yoakumcad.org/', platform: 'bis' },
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
// Spot-check key counties
const check = ['Bowie','Caldwell','Cameron','Callahan','Falls','Howard','Liberty','Zapata','Tarrant','El Paso'];
check.forEach(c => console.log(' ', c, ':', TX[c] ? TX[c].url : 'NOT FOUND'));
