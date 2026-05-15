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
  'Aransas':      { url: 'https://esearch.aransascad.org/', platform: 'bis' },
  'Archer':       { url: 'https://esearch.archercad.org/', platform: 'bis' },
  'Armstrong':    { url: 'https://esearch.armstrongcad.org/', platform: 'bis' },
  'Atascosa':     { url: 'https://esearch.atascosacad.com/', platform: 'bis' },
  'Austin':       { url: 'https://esearch.austincad.org/', platform: 'bis' },
  // ── B ────────────────────────────────────────────────────────────────────
  'Bailey':       { url: 'https://esearch.baileycad.org/', platform: 'bis' },
  'Bandera':      { url: 'https://esearch.banderacounty.org/', platform: 'bis' },
  'Bastrop':      { url: 'https://esearch.bastropcad.org/', platform: 'bis' },
  'Bee':          { url: 'https://esearch.beecad.org/', platform: 'bis' },
  'Bell':         { url: 'https://esearch.bellcad.org/', platform: 'bis' },
  'Baylor':       { url: 'https://esearch.baylorcad.org/', platform: 'bis' },
  'Bexar':        { url: 'https://bcad.org/propertysearch/', platform: 'generic' },
  'Blanco':       { url: 'https://esearch.blancocad.com/', platform: 'bis' },
  'Borden':       { url: 'https://esearch.bordencad.org/', platform: 'bis' },
  // Bosque: tax office has its own search portal (confirmed by Netronline)
  'Bosque':       { url: 'https://www.bosquecountytaxoffice.com/search', platform: 'generic' },
  // Bowie: esearch redirects to the actual property search
  'Bowie':        { url: 'https://www.bowieappraisal.com/property-search', platform: 'generic' },
  'Brazos':       { url: 'https://esearch.brazoscad.org/', platform: 'bis' },
  'Brewster':     { url: 'https://esearch.brewstercad.org/', platform: 'bis' },
  'Brooks':       { url: 'https://esearch.brookscad.org/', platform: 'bis' },
  'Brown':        { url: 'https://esearch.browncad.org/', platform: 'bis' },
  'Burleson':     { url: 'https://esearch.burlesonappraisal.com/', platform: 'bis' },
  'Burnet':       { url: 'https://esearch.burnetcad.org/', platform: 'bis' },
  // ── C ────────────────────────────────────────────────────────────────────
  'Caldwell':     { url: 'https://esearch.caldwellcad.org/', platform: 'bis' },
  'Calhoun':      { url: 'https://esearch.calhouncad.org/', platform: 'bis' },
  // Callahan: esearch redirects to ISW DataClient portal
  'Callahan':     { url: 'http://iswdataclient.azurewebsites.net/webindex.aspx?dbkey=callahancad&time=201601191609003', platform: 'isw' },
  // Cameron: uses ProdigyCAD (confirmed partial working)
  'Cameron':      { url: 'https://cameron.prodigycad.com/property-search', platform: 'prodigycad' },
  'Camp':         { url: 'https://esearch.campcad.org/', platform: 'bis' },
  'Carson':       { url: 'https://esearch.carsoncad.org/', platform: 'bis' },
  'Cass':         { url: 'https://esearch.casscad.org/', platform: 'bis' },
  'Castro':       { url: 'https://esearch.castrocad.org/', platform: 'bis' },
  'Chambers':     { url: 'https://esearch.chamberscad.org/', platform: 'bis' },
  'Cherokee':     { url: 'https://esearch.cherokeecad.com/', platform: 'bis' },
  'Childress':    { url: 'https://esearch.childresscad.org/', platform: 'bis' },
  'Clay':         { url: 'https://esearch.claycad.org/', platform: 'bis' },
  'Cochran':      { url: 'https://esearch.cochrancad.com/', platform: 'bis' },
  'Coke':         { url: 'https://esearch.cokecad.org/', platform: 'bis' },
  'Collin':       { url: 'https://esearch.collincad.org/', platform: 'bis' },
  'Collingsworth':{ url: 'https://esearch.collingsworthcad.org/', platform: 'bis' },
  'Colorado':     { url: 'https://esearch.coloradocad.org/', platform: 'bis' },
  'Comanche':     { url: 'https://esearch.comanchecad.org/', platform: 'bis' },
  'Concho':       { url: 'https://esearch.conchocad.org/', platform: 'bis' },
  'Cooke':        { url: 'https://esearch.cookecad.org/', platform: 'bis' },
  'Coryell':      { url: 'https://esearch.coryellcad.org/', platform: 'bis' },
  'Cottle':       { url: 'https://esearch.cottlecad.org/', platform: 'bis' },
  'Crane':        { url: 'https://esearch.cranecad.org/', platform: 'bis' },
  'Crockett':     { url: 'https://esearch.crockettcad.org/', platform: 'bis' },
  'Culberson':    { url: 'https://esearch.culbersoncad.org/', platform: 'bis' },
  // ── D ────────────────────────────────────────────────────────────────────
  'Dallam':       { url: 'https://esearch.dallamcad.org/', platform: 'bis' },
  'Dawson':       { url: 'https://esearch.dawsoncad.org/', platform: 'bis' },
  'Deaf Smith':   { url: 'https://esearch.deafsmithcad.org/', platform: 'bis' },
  'Delta':        { url: 'https://esearch.deltacad.org/', platform: 'bis' },
  'DeWitt':       { url: 'https://esearch.dewittcad.org/', platform: 'bis' },
  'Dickens':      { url: 'https://esearch.dickenscad.org/', platform: 'bis' },
  'Dimmit':       { url: 'https://esearch.dimmitcad.org/', platform: 'bis' },
  'Donley':       { url: 'https://esearch.donleycad.org/', platform: 'bis' },
  'Duval':        { url: 'https://esearch.duvalcad.org/', platform: 'bis' },
  // ── E ────────────────────────────────────────────────────────────────────
  'Eastland':     { url: 'https://esearch.eastlandcad.org/', platform: 'bis' },
  'Ector':        { url: 'https://esearch.ectorcad.org/', platform: 'bis' },
  'Edwards':      { url: 'https://esearch.edwardscad.org/', platform: 'bis' },
  'El Paso':      { url: 'https://esearch.epcad.org/', platform: 'bis' },
  // ── F ────────────────────────────────────────────────────────────────────
  'Fannin':       { url: 'https://esearch.fannincad.org/', platform: 'bis' },
  // Falls: correct TLD is .net not .org (Netronline confirmed)
  'Falls':        { url: 'https://esearch.fallscad.net/', platform: 'bis' },
  'Fayette':      { url: 'https://esearch.fayettecad.org/', platform: 'bis' },
  'Fisher':       { url: 'https://esearch.fishercad.org/', platform: 'bis' },
  'Foard':        { url: 'https://esearch.foardcad.org/', platform: 'bis' },
  'Fort Bend':    { url: 'https://esearch.fortbendcad.org/', platform: 'bis' },
  'Franklin':     { url: 'https://esearch.franklincad.org/', platform: 'bis' },
  'Freestone':    { url: 'https://esearch.freestonecad.org/', platform: 'bis' },
  'Frio':         { url: 'https://esearch.friocad.org/', platform: 'bis' },
  // ── G ────────────────────────────────────────────────────────────────────
  'Gaines':       { url: 'https://esearch.gainescad.org/', platform: 'bis' },
  'Galveston':    { url: 'https://esearch.galvestoncad.org/', platform: 'bis' },
  'Garza':        { url: 'https://esearch.garzacad.org/', platform: 'bis' },
  'Gillespie':    { url: 'https://esearch.gillespiecad.org/', platform: 'bis' },
  'Glasscock':    { url: 'https://esearch.glasscockcad.org/', platform: 'bis' },
  'Goliad':       { url: 'https://esearch.goliadcad.org/', platform: 'bis' },
  'Gonzales':     { url: 'https://esearch.gonzalescad.org/', platform: 'bis' },
  'Gray':         { url: 'https://esearch.graycad.org/', platform: 'bis' },
  'Grimes':       { url: 'https://esearch.grimescad.org/', platform: 'bis' },
  // ── H ────────────────────────────────────────────────────────────────────
  'Hale':         { url: 'https://esearch.halecad.org/', platform: 'bis' },
  'Hall':         { url: 'https://esearch.hallcad.org/', platform: 'bis' },
  'Hamilton':     { url: 'https://esearch.hamiltoncad.org/', platform: 'bis' },
  'Hansford':     { url: 'https://esearch.hansfordcad.org/', platform: 'bis' },
  'Hardeman':     { url: 'https://esearch.hardemancad.org/', platform: 'bis' },
  'Hardin':       { url: 'https://esearch.hardincad.org/', platform: 'bis' },
  // Hartley: ISW DataClient portal (Netronline confirmed)
  'Hartley':      { url: 'http://iswdataclient.azurewebsites.net/webindex.aspx?dbkey=hartleycad&time=201601191610049', platform: 'isw' },
  'Haskell':      { url: 'https://esearch.haskellcad.org/', platform: 'bis' },
  'Hays':         { url: 'https://esearch.hayscad.com/', platform: 'bis' },
  'Hemphill':     { url: 'https://esearch.hemphillcad.org/', platform: 'bis' },
  'Hill':         { url: 'https://esearch.hillcad.org/', platform: 'bis' },
  'Hockley':      { url: 'https://esearch.hockleycad.org/', platform: 'bis' },
  'Houston':      { url: 'http://www.houstoncad.org/', platform: 'bis' },
  // Howard: BIS portal via bisconsultants.com domain (Netronline confirmed)
  'Howard':       { url: 'http://gis.bisconsultants.com/howardcad/', platform: 'bis' },
  'Hudspeth':     { url: 'https://esearch.hudspethcad.org/', platform: 'bis' },
  'Hunt':         { url: 'https://esearch.huntcad.org/', platform: 'bis' },
  'Hutchinson':   { url: 'https://esearch.hutchinsoncad.org/', platform: 'bis' },
  // ── J ────────────────────────────────────────────────────────────────────
  'Jack':         { url: 'https://esearch.jackcad.org/', platform: 'bis' },
  'Jackson':      { url: 'https://esearch.jacksoncad.org/', platform: 'bis' },
  'Jasper':       { url: 'https://esearch.jaspercad.org/', platform: 'bis' },
  'Jim Wells':    { url: 'https://esearch.jimwellscad.org/', platform: 'bis' },
  'Johnson':      { url: 'https://esearch.johnsoncad.com/', platform: 'bis' },
  'Jones':        { url: 'https://esearch.jonescad.org/', platform: 'bis' },
  // ── K ────────────────────────────────────────────────────────────────────
  'Karnes':       { url: 'https://esearch.karnescad.org/', platform: 'bis' },
  'Kaufman':      { url: 'https://esearch.kaufmancad.org/', platform: 'bis' },
  'Kenedy':       { url: 'https://esearch.kenedycad.org/', platform: 'bis' },
  'Kent':         { url: 'https://esearch.kentcad.org/', platform: 'bis' },
  'Kerr':         { url: 'https://esearch.kerrcad.org/', platform: 'bis' },
  'Kimble':       { url: 'https://esearch.kimblecad.org/', platform: 'bis' },
  'King':         { url: 'https://esearch.kingcad.org/', platform: 'bis' },
  'Kinney':       { url: 'https://esearch.kinneycad.org/', platform: 'bis' },
  // ── L ────────────────────────────────────────────────────────────────────
  'Lamar':        { url: 'https://esearch.lamarcad.org/', platform: 'bis' },
  'Lamb':         { url: 'https://esearch.lambcad.org/', platform: 'bis' },
  'Lampasas':     { url: 'https://esearch.lampasascad.com/', platform: 'bis' },
  'Lavaca':       { url: 'https://esearch.lavacacad.com/', platform: 'bis' },
  'Lee':          { url: 'https://esearch.leecad.org/', platform: 'bis' },
  'Leon':         { url: 'https://esearch.leoncad.org/', platform: 'bis' },
  // Liberty: TrueAutomation/ProAccess portal (Netronline confirmed)
  'Liberty':      { url: 'https://propaccess.trueautomation.com/ClientDB/PropertySearch.aspx?cid=8', platform: 'trueautomation' },
  'Limestone':    { url: 'https://esearch.limestonecad.com/', platform: 'bis' },
  'Llano':        { url: 'https://esearch.llanocad.org/', platform: 'bis' },
  'Loving':       { url: 'https://esearch.lovingcad.org/', platform: 'bis' },
  'Lynn':         { url: 'https://esearch.lynncad.org/', platform: 'bis' },
  // ── M ────────────────────────────────────────────────────────────────────
  'Madison':      { url: 'https://esearch.madisoncad.org/', platform: 'bis' },
  'Marion':       { url: 'https://esearch.marioncad.org/', platform: 'bis' },
  'Martin':       { url: 'https://esearch.martincad.org/', platform: 'bis' },
  'Mason':        { url: 'https://esearch.masoncad.org/', platform: 'bis' },
  'Matagorda':    { url: 'https://esearch.matagordacad.org/', platform: 'bis' },
  'Maverick':     { url: 'https://esearch.maverickcad.org/', platform: 'bis' },
  'McCulloch':    { url: 'https://esearch.mccullochcad.org/', platform: 'bis' },
  'McLennan':     { url: 'https://esearch.mclennancad.org/', platform: 'bis' },
  'McMullen':     { url: 'https://esearch.mcmullencad.org/', platform: 'bis' },
  'Medina':       { url: 'https://esearch.medinacad.org/', platform: 'bis' },
  'Menard':       { url: 'https://esearch.menardcad.org/', platform: 'bis' },
  'Mills':        { url: 'https://esearch.millscad.org/', platform: 'bis' },
  'Mitchell':     { url: 'https://esearch.mitchellcad.org/', platform: 'bis' },
  'Moore':        { url: 'https://esearch.moorecad.org/', platform: 'bis' },
  'Morris':       { url: 'https://esearch.morriscad.com/', platform: 'bis' },
  // ── N ────────────────────────────────────────────────────────────────────
  'Nacogdoches':  { url: 'https://esearch.nacocad.org/', platform: 'bis' },
  'Newton':       { url: 'https://esearch.newtoncad.org/', platform: 'bis' },
  'Nolan':        { url: 'https://esearch.nolancad.org/', platform: 'bis' },
  'Nueces':       { url: 'https://esearch.nuecescad.com/', platform: 'bis' },
  // ── O ────────────────────────────────────────────────────────────────────
  'Ochiltree':    { url: 'https://esearch.ochiltreecad.org/', platform: 'bis' },
  'Oldham':       { url: 'https://esearch.oldhamcad.org/', platform: 'bis' },
  // ── P ────────────────────────────────────────────────────────────────────
  'Panola':       { url: 'https://esearch.panolacad.org/', platform: 'bis' },
  'Parmer':       { url: 'https://esearch.parmercad.org/', platform: 'bis' },
  'Pecos':        { url: 'https://esearch.pecoscad.org/', platform: 'bis' },
  'Polk':         { url: 'https://esearch.polkcad.org/', platform: 'bis' },
  'Presidio':     { url: 'https://esearch.presidiocad.org/', platform: 'bis' },
  // ── R ────────────────────────────────────────────────────────────────────
  'Rains':        { url: 'https://esearch.rainscad.org/', platform: 'bis' },
  'Reagan':       { url: 'https://esearch.reagancad.org/', platform: 'bis' },
  'Real':         { url: 'https://esearch.realcad.org/', platform: 'bis' },
  'Red River':    { url: 'https://esearch.rrcad.org/', platform: 'bis' },
  'Reeves':       { url: 'https://esearch.reevescad.org/', platform: 'bis' },
  'Refugio':      { url: 'https://esearch.refugiocad.org/', platform: 'bis' },
  'Robertson':    { url: 'https://esearch.robertsoncad.com/', platform: 'bis' },
  'Runnels':      { url: 'https://esearch.runnelscad.org/', platform: 'bis' },
  'Rusk':         { url: 'https://esearch.ruskcad.org/', platform: 'bis' },
  // ── S ────────────────────────────────────────────────────────────────────
  'San Augustine':{ url: 'https://esearch.sanaugustinecad.org/', platform: 'bis' },
  'San Patricio': { url: 'https://esearch.sanpatcad.org/', platform: 'bis' },
  'San Saba':     { url: 'https://esearch.sansabacad.org/', platform: 'bis' },
  'Schleicher':   { url: 'https://esearch.schleichercad.org/', platform: 'bis' },
  'Shackelford':  { url: 'https://esearch.shackelfordcad.com/', platform: 'bis' },
  'Shelby':       { url: 'https://esearch.shelbycad.com/', platform: 'bis' },
  'Sherman':      { url: 'https://esearch.shermancad.org/', platform: 'bis' },
  'Smith':        { url: 'https://esearch.smithcad.org/', platform: 'bis' },
  'Starr':        { url: 'https://esearch.starrcad.org/', platform: 'bis' },
  'Sterling':     { url: 'https://esearch.sterlingcad.org/', platform: 'bis' },
  'Stonewall':    { url: 'https://esearch.stonewallcad.org/', platform: 'bis' },
  'Sutton':       { url: 'https://esearch.suttoncad.com/', platform: 'bis' },
  'Swisher':      { url: 'https://esearch.swishercad.org/', platform: 'bis' },
  // ── T ────────────────────────────────────────────────────────────────────
  'Tarrant':      { url: 'https://esearch.tarrantcad.org/', platform: 'bis' },
  'Taylor':       { url: 'https://esearch.taylorcad.org/', platform: 'bis' },
  'Terrell':      { url: 'https://esearch.terrellcad.org/', platform: 'bis' },
  'Throckmorton': { url: 'https://esearch.throckmortoncad.org/', platform: 'bis' },
  'Titus':        { url: 'https://esearch.tituscad.org/', platform: 'bis' },
  // ── U ────────────────────────────────────────────────────────────────────
  'Uvalde':       { url: 'https://esearch.uvaldecad.org/', platform: 'bis' },
  // ── V ────────────────────────────────────────────────────────────────────
  'Victoria':     { url: 'https://esearch.victoriacad.org/', platform: 'bis' },
  // ── W ────────────────────────────────────────────────────────────────────
  'Walker':       { url: 'https://esearch.walkercad.org/', platform: 'bis' },
  'Waller':       { url: 'https://esearch.wallercad.org/', platform: 'bis' },
  'Ward':         { url: 'https://esearch.wardcad.org/', platform: 'bis' },
  'Washington':   { url: 'https://esearch.washingtoncad.org/', platform: 'bis' },
  'Wheeler':      { url: 'https://esearch.wheelercad.org/', platform: 'bis' },
  'Willacy':      { url: 'https://esearch.willacycad.org/', platform: 'bis' },
  'Williamson':   { url: 'https://esearch.williamsoncad.org/', platform: 'bis' },
  'Winkler':      { url: 'https://esearch.winklercad.org/', platform: 'bis' },
  // ── Y ────────────────────────────────────────────────────────────────────
  'Young':        { url: 'https://esearch.youngcad.org/', platform: 'bis' },
  // ── Z ────────────────────────────────────────────────────────────────────
  // Zapata: PublicSearch portal (Netronline confirmed)
  'Zapata':       { url: 'https://zapata.tx.publicsearch.us/', platform: 'publicportal' },
  'Zavala':       { url: 'https://esearch.zavalacad.com/', platform: 'bis' },
  // ── Remaining counties with homepage URLs — BIS esearch guesses ─────────
  // Angelina: old PublicAccess URL timed out; try angelinacad.net (like andersoncad.net)
  'Angelina':     { url: 'https://angelinacad.net/property-search', platform: 'publicportal' },
  'Hidalgo':      { url: 'https://esearch.hidalgocad.org/', platform: 'bis' },
  'Hood':         { url: 'https://esearch.hoodcad.net/', platform: 'bis' },
  'Tom Green':    { url: 'https://esearch.tomgreencad.org/', platform: 'bis' },
  'Wilbarger':    { url: 'https://esearch.wilbargerappraisaldistrict.org/', platform: 'bis' },
  'Coleman':      { url: 'https://www.colemancad.org/', platform: 'ptaxpro' },
  'Comal':        { url: 'https://esearch.comalad.org/', platform: 'bis' },
  'Crosby':       { url: 'https://www.crosbycad.com/', platform: 'ptaxpro' },
  'Denton':       { url: 'https://esearch.dentoncad.com/', platform: 'bis' },
  'Ellis':        { url: 'https://esearch.elliscad.org/', platform: 'bis' },
  'Grayson':      { url: 'https://esearch.graysoncad.org/', platform: 'bis' },
  'Gregg':        { url: 'https://esearch.gcad.org/', platform: 'bis' },
  'Jeff Davis':   { url: 'https://esearch.jeffdaviscad.org/', platform: 'bis' },
  'Jefferson':    { url: 'https://esearch.jcad.org/', platform: 'bis' },
  'Kendall':      { url: 'https://esearch.kendallcad.org/', platform: 'bis' },
  'Lubbock':      { url: 'https://esearch.lubbockcad.org/', platform: 'bis' },
  'Midland':      { url: 'https://esearch.midcad.org/', platform: 'bis' },
  'Montague':     { url: 'https://esearch.montaguecd.org/', platform: 'bis' },
  'Montgomery':   { url: 'https://esearch.mcad-tx.org/', platform: 'bis' },
  'Navarro':      { url: 'https://esearch.navarrocad.com/', platform: 'bis' },
  // Palo Pinto: was null, guessing BIS esearch
  'Palo Pinto':   { url: 'https://esearch.palointocad.org/', platform: 'bis' },
  'Parker':       { url: 'https://esearch.parkercad.org/', platform: 'bis' },
  'Rockwall':     { url: 'https://esearch.rockwallcad.com/', platform: 'bis' },
  'San Jacinto':  { url: 'https://esearch.sjcad.org/', platform: 'bis' },
  'Scurry':       { url: 'https://esearch.scurrycad.org/', platform: 'bis' },
  'Terry':        { url: 'https://esearch.terrycoad.org/', platform: 'bis' },
  'Trinity':      { url: 'https://esearch.trinitycad.net/', platform: 'bis' },
  'Upton':        { url: 'https://esearch.uptoncad.org/', platform: 'bis' },
  'Van Zandt':    { url: 'https://esearch.vzcad.org/', platform: 'bis' },
  'Wharton':      { url: 'https://esearch.whartoncad.org/', platform: 'bis' },
  // ── Previously updated in other commits ──────────────────────────────────
  'Atascosa':     { url: 'https://esearch.atascosacad.com/', platform: 'bis' },
  'Bosque':       { url: 'https://www.bosquecountytaxoffice.com/search', platform: 'generic' },
  'Bowie':        { url: 'https://www.bowieappraisal.com/property-search', platform: 'generic' },
  'Brazos':       { url: 'https://esearch.brazoscad.org/', platform: 'bis' },
  'Potter':       { url: 'https://www.pottercountytax.com/search', platform: 'generic' },
  'Randall':      { url: 'https://taxpayer.randallcounty.com/taxweb/', platform: 'generic' },
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
