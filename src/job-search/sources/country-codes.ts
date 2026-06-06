/**
 * Infer a two-letter ISO 3166-1 country code from a free-text location string.
 * Covers all EU/EEA tech hubs with their major cities.
 * Returns null for unrecognised locations (caller decides how to handle).
 * "Europe/worldwide/remote" → 'FR' because the candidate is Paris-based.
 */
export function inferCountryCode(location: string): string | null {
  const l = (location ?? '').toLowerCase();

  // France
  if (l.includes('france') || l.includes('paris') || l.includes('lyon') ||
      l.includes('marseille') || l.includes('bordeaux') || l.includes('toulouse') ||
      l.includes('nantes') || l.includes('lille') || l.includes('strasbourg') ||
      l.includes('montpellier') || l.includes('rennes') || l.includes('nice') ||
      l.includes('grenoble') || l.includes('sophia antipolis')) return 'FR';

  // Germany
  if (l.includes('germany') || l.includes('berlin') || l.includes('munich') ||
      l.includes('münchen') || l.includes('hamburg') || l.includes('frankfurt') ||
      l.includes('cologne') || l.includes('köln') || l.includes('koeln') ||
      l.includes('stuttgart') || l.includes('düsseldorf') || l.includes('dusseldorf') ||
      l.includes('dortmund') || l.includes('dresden') || l.includes('leipzig') ||
      l.includes('hannover') || l.includes('nürnberg') || l.includes('nuremberg') ||
      l.includes('bremen') || l.includes('bonn') || l.includes('mannheim') ||
      l.includes('karlsruhe') || l.includes('augsburg') || l.includes('wiesbaden')) return 'DE';

  // Netherlands
  if (l.includes('netherlands') || l.includes('holland') || l.includes('amsterdam') ||
      l.includes('rotterdam') || l.includes('utrecht') || l.includes('eindhoven') ||
      l.includes('den haag') || l.includes('the hague') || l.includes('groningen') ||
      l.includes('tilburg') || l.includes('breda') || l.includes('nijmegen')) return 'NL';

  // Belgium
  if (l.includes('belgium') || l.includes('brussels') || l.includes('bruxelles') ||
      l.includes('antwerp') || l.includes('antwerpen') || l.includes('ghent') ||
      l.includes('gent') || l.includes('liège') || l.includes('liege') ||
      l.includes('bruges') || l.includes('brugge') || l.includes('leuven')) return 'BE';

  // Switzerland
  if (l.includes('switzerland') || l.includes('zurich') || l.includes('zürich') ||
      l.includes('geneva') || l.includes('genève') || l.includes('geneve') ||
      l.includes('basel') || l.includes('bern') || l.includes('lausanne') ||
      l.includes('zug') || l.includes('lugano')) return 'CH';

  // Austria
  if (l.includes('austria') || l.includes('vienna') || l.includes('wien') ||
      l.includes('graz') || l.includes('salzburg') || l.includes('linz') ||
      l.includes('innsbruck') || l.includes('klagenfurt')) return 'AT';

  // United Kingdom
  if (l.includes('united kingdom') || l.includes(' uk') || l.startsWith('uk') ||
      l.includes('london') || l.includes('manchester') || l.includes('birmingham') ||
      l.includes('edinburgh') || l.includes('bristol') || l.includes('leeds') ||
      l.includes('sheffield') || l.includes('glasgow') || l.includes('cambridge') ||
      l.includes('oxford') || l.includes('england') || l.includes('scotland') ||
      l.includes('wales')) return 'GB';

  // Poland
  if (l.includes('poland') || l.includes('warsaw') || l.includes('warszawa') ||
      l.includes('krakow') || l.includes('kraków') || l.includes('wroclaw') ||
      l.includes('wrocław') || l.includes('gdansk') || l.includes('gdańsk') ||
      l.includes('poznan') || l.includes('poznań') || l.includes('lodz') ||
      l.includes('łódź') || l.includes('katowice') || l.includes('lublin') ||
      l.includes('bialystok') || l.includes('szczecin')) return 'PL';

  // Sweden
  if (l.includes('sweden') || l.includes('stockholm') || l.includes('gothenburg') ||
      l.includes('göteborg') || l.includes('malmo') || l.includes('malmö') ||
      l.includes('uppsala') || l.includes('linköping') || l.includes('linkoping') ||
      l.includes('västerås') || l.includes('vasteras') || l.includes('örebro')) return 'SE';

  // Spain
  if (l.includes('spain') || l.includes('madrid') || l.includes('barcelona') ||
      l.includes('valencia') || l.includes('seville') || l.includes('sevilla') ||
      l.includes('bilbao') || l.includes('málaga') || l.includes('malaga') ||
      l.includes('zaragoza') || l.includes('alicante') || l.includes('granada')) return 'ES';

  // Portugal
  if (l.includes('portugal') || l.includes('lisbon') || l.includes('lisboa') ||
      l.includes('porto') || l.includes('oporto') || l.includes('braga') ||
      l.includes('coimbra') || l.includes('aveiro')) return 'PT';

  // Ireland
  if (l.includes('ireland') || l.includes('dublin') || l.includes('cork') ||
      l.includes('galway') || l.includes('limerick') || l.includes('waterford')) return 'IE';

  // Denmark
  if (l.includes('denmark') || l.includes('copenhagen') || l.includes('københavn') ||
      l.includes('kobenhavn') || l.includes('aarhus') || l.includes('odense') ||
      l.includes('aalborg')) return 'DK';

  // Finland
  if (l.includes('finland') || l.includes('helsinki') || l.includes('tampere') ||
      l.includes('espoo') || l.includes('vantaa') || l.includes('oulu') ||
      l.includes('turku') || l.includes('jyväskylä')) return 'FI';

  // Norway
  if (l.includes('norway') || l.includes('oslo') || l.includes('bergen') ||
      l.includes('trondheim') || l.includes('stavanger') || l.includes('tromsø') ||
      l.includes('tromso')) return 'NO';

  // Czech Republic
  if (l.includes('czechia') || l.includes('czech republic') || l.includes('czech') ||
      l.includes('prague') || l.includes('praha') || l.includes('brno') ||
      l.includes('ostrava') || l.includes('plzeň') || l.includes('plzen')) return 'CZ';

  // Italy
  if (l.includes('italy') || l.includes('rome') || l.includes('roma') ||
      l.includes('milan') || l.includes('milano') || l.includes('turin') ||
      l.includes('torino') || l.includes('florence') || l.includes('firenze') ||
      l.includes('naples') || l.includes('napoli') || l.includes('bologna') ||
      l.includes('venice') || l.includes('venezia') || l.includes('genoa') ||
      l.includes('genova')) return 'IT';

  // Luxembourg
  if (l.includes('luxembourg')) return 'LU';

  // Greece
  if (l.includes('greece') || l.includes('athens') || l.includes('αθήνα') ||
      l.includes('thessaloniki')) return 'GR';

  // Hungary
  if (l.includes('hungary') || l.includes('budapest')) return 'HU';

  // Slovakia
  if (l.includes('slovakia') || l.includes('bratislava') || l.includes('košice') ||
      l.includes('kosice')) return 'SK';

  // Slovenia
  if (l.includes('slovenia') || l.includes('ljubljana')) return 'SI';

  // Estonia
  if (l.includes('estonia') || l.includes('tallinn')) return 'EE';

  // Iceland
  if (l.includes('iceland') || l.includes('reykjavik') || l.includes('reykjavík')) return 'IS';

  // USA — explicit reject signal, not a fallback
  if (l.includes('united states') || l.includes('usa') || l.includes('us only') ||
      l.includes('new york') || l.includes('san francisco') || l.includes('los angeles') ||
      l.includes('chicago') || l.includes('austin') || l.includes('seattle') ||
      l.includes('boston') || l.includes('denver') || l.includes('atlanta')) return 'US';

  // Anywhere/remote/EU-wide → treat as FR-compatible (candidate works from Paris)
  if (l.includes('europe') || l.includes(' eu ') || l.includes('worldwide') ||
      l.includes('anywhere') || l.includes('remote') || l === 'global' || l === '') return 'FR';

  return null;
}
