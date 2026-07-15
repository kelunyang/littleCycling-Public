/**
 * Attribution / licensing notices for the third-party open-data sources the
 * game streams at runtime. Every source here is free to use but its licence
 * (OSM ODbL, Open-Meteo CC-BY, AWS Terrain Tiles) requires a visible credit.
 *
 * This is static reference data: the server hands it to clients via the
 * redacted config read (GET /api/config) and the frontend only renders it,
 * mirroring how EuroVelo route attribution flows through the catalog API.
 *
 * EuroVelo route data is credited separately (see eurovelo-catalog / the
 * catalog drawer); it is not repeated here.
 */

export interface AttributionLink {
  name: string; // link text, e.g. 'ODbL' or 'OpenFreeMap'
  url: string;  // licence text or source homepage
}

export interface DataSourceAttribution {
  role: string;                // what it provides, e.g. 'Basemap', 'Terrain', 'Weather'
  text: string;                // credit line shown to the user
  links: AttributionLink[];    // licence / source links shown after the text
}

export const DATA_ATTRIBUTIONS: DataSourceAttribution[] = [
  {
    role: 'Basemap',
    text: 'Map data © OpenStreetMap contributors, vector tiles by OpenFreeMap.',
    links: [
      { name: 'ODbL', url: 'https://opendatacommons.org/licenses/odbl/1-0/' },
      { name: 'OpenFreeMap', url: 'https://openfreemap.org/' },
    ],
  },
  {
    role: 'Terrain',
    text: 'Elevation data: AWS Terrain Tiles (SRTM, GMTED2010 and others).',
    links: [
      { name: 'AWS Open Data', url: 'https://registry.opendata.aws/terrain-tiles/' },
    ],
  },
  {
    role: 'Weather',
    text: 'Weather data by Open-Meteo.com.',
    links: [
      { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
      { name: 'Open-Meteo', url: 'https://open-meteo.com/' },
    ],
  },
];
