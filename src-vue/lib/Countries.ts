import { IConfig } from '../interfaces/IConfig.ts';

export interface ICountry {
  name: string;
  value: string;
}

interface GeoIpResponse {
  city?: string | null;
  region?: string | null;
  state?: string | null;
  country?: string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
}

export async function getUserJurisdiction(): Promise<IConfig['userJurisdiction']> {
  const ipResponse = await fetch('https://api.ipify.org?format=json');
  const { ip: ipAddress } = await ipResponse.json();

  const geoResponse = await fetch(`https://api.hackertarget.com/geoip/?q=${ipAddress}&output=json`);
  const { city, region, state, country: countryStr, latitude, longitude } = (await geoResponse.json()) as GeoIpResponse;
  const resolvedCity = city ?? '';
  const resolvedCountryStr = countryStr ?? '';
  const country = Countries.closestMatch(resolvedCountryStr);
  const latitudeStr = latitude != null ? String(latitude) : '';
  const longitudeStr = longitude != null ? String(longitude) : '';
  const resolvedRegion = region || state || '';

  return {
    ipAddress,
    city: resolvedCity,
    region: resolvedRegion,
    countryName: country?.name || resolvedCountryStr,
    countryCode: country?.value || '',
    latitude: latitudeStr,
    longitude: longitudeStr,
  };
}

export default class Countries {
  public static get all(): ICountry[] {
    return [...this.data];
  }

  public static byISOCode(isoCode: string): ICountry | undefined {
    return this.data.find(country => country.value === isoCode);
  }

  public static closestMatch(name: string): ICountry | undefined {
    // First try exact match
    const exactMatch = this.data.find(country => country.name === name);
    if (exactMatch) return exactMatch;

    const normalizedInput = name.toLowerCase().trim();
    let bestMatch: ICountry | undefined;
    let bestScore = -Infinity;

    for (const country of this.data) {
      const normalizedCountryName = country.name.toLowerCase();

      // Calculate a more sophisticated similarity score
      const score = this.calculateSimilarityScore(normalizedInput, normalizedCountryName);

      // If this is a better match, update our best match
      if (score > bestScore) {
        bestScore = score;
        bestMatch = country;
      }
    }

    // Only return a match if the score is reasonable
    const minScore = 0.3; // Adjust this threshold as needed
    return bestScore >= minScore ? bestMatch : undefined;
  }

  /**
   * Calculate the Levenshtein distance between two strings
   * This measures how many single-character edits are needed to transform one string into another
   */
  private static levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    // Initialize the matrix
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    // Fill the matrix
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1, // deletion
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * Calculate a similarity score between two strings
   * Higher scores indicate better matches
   */
  private static calculateSimilarityScore(input: string, countryName: string): number {
    // Check for exact substring match (highest priority)
    if (countryName.includes(input) || input.includes(countryName)) {
      return 1.0;
    }

    // Handle common abbreviations and acronyms
    const abbreviationMatches = this.checkAbbreviations(input, countryName);
    if (abbreviationMatches > 0) {
      return abbreviationMatches;
    }

    // Check for word-based matches
    const inputWords = input.split(/\s+/).filter(word => word.length > 0);
    const countryWords = countryName.split(/\s+/).filter(word => word.length > 0);

    let wordMatchScore = 0;
    let matchedWords = 0;

    for (const inputWord of inputWords) {
      for (const countryWord of countryWords) {
        if (countryWord.includes(inputWord) || inputWord.includes(countryWord)) {
          wordMatchScore +=
            Math.min(inputWord.length, countryWord.length) / Math.max(inputWord.length, countryWord.length);
          matchedWords++;
          break;
        }
      }
    }

    if (matchedWords > 0) {
      wordMatchScore = wordMatchScore / inputWords.length;
    }

    // Calculate Levenshtein distance as a fallback
    const maxLength = Math.max(input.length, countryName.length);
    const levenshteinDistance = this.levenshteinDistance(input, countryName);
    const levenshteinScore = 1 - levenshteinDistance / maxLength;

    // Combine scores with word matches having higher weight
    const finalScore = wordMatchScore * 0.7 + levenshteinScore * 0.3;

    return finalScore;
  }

  /**
   * Check for common abbreviations and acronyms
   */
  private static checkAbbreviations(input: string, countryName: string): number {
    const abbreviations: { [key: string]: string[] } = {
      usa: ['united states of america', 'united states'],
      uk: ['united kingdom of great britain and northern ireland', 'united kingdom'],
      gb: ['united kingdom of great britain and northern ireland', 'united kingdom'],
      us: ['united states of america', 'united states'],
      uae: ['united arab emirates'],
      drc: ['congo (democratic republic of the)'],
      congo: ['congo (democratic republic of the)', 'congo'],
      laos: ["lao people's democratic republic"],
      vietnam: ['viet nam'],
      myanmar: ['myanmar'],
      burma: ['myanmar'],
      'czech republic': ['czechia'],
      czech: ['czechia'],
      swaziland: ['eswatini'],
      timor: ['timor-leste'],
      'east timor': ['timor-leste'],
      'cape verde': ['cabo verde'],
      'ivory coast': ["côte d'ivoire"],
      "cote d'ivoire": ["côte d'ivoire"],
      taiwan: ['taiwan, province of china'],
      palestine: ['palestine, state of'],
      syria: ['syrian arab republic'],
      iran: ['iran'],
      persia: ['iran'],
      'north korea': ["korea (democratic people's republic of)"],
      'south korea': ['korea (republic of)'],
      'north macedonia': ['north macedonia'],
      macedonia: ['north macedonia'],
      moldova: ['moldova (republic of)'],
      venezuela: ['venezuela (bolivarian republic of)'],
      tanzania: ['tanzania, united republic of'],
      brunei: ['brunei darussalam'],
      micronesia: ['micronesia (federated states of)'],
      'saint kitts': ['saint kitts and nevis'],
      'saint lucia': ['saint lucia'],
      'saint vincent': ['saint vincent and the grenadines'],
      'saint pierre': ['saint pierre and miquelon'],
      'saint martin': ['saint martin (french part)'],
      'sint maarten': ['sint maarten (dutch part)'],
      bonaire: ['bonaire, sint eustatius and saba'],
      'saint helena': ['saint helena, ascension and tristan da cunha'],
      'south georgia': ['south georgia and the south sandwich islands'],
      'heard island': ['heard island and mcdonald islands'],
      svalbard: ['svalbard and jan mayen'],
      reunion: ['réunion'],
      curacao: ['curaçao'],
      'saint barthelemy': ['saint barthélemy'],
    };

    const normalizedInput = input.toLowerCase();
    const normalizedCountryName = countryName.toLowerCase();

    // Check if input is an abbreviation for this country
    if (abbreviations[normalizedInput]) {
      if (abbreviations[normalizedInput].includes(normalizedCountryName)) {
        return 0.9; // High score for abbreviation matches
      }
    }

    // Check if country name is an abbreviation for the input
    for (const [abbr, countries] of Object.entries(abbreviations)) {
      if (countries.includes(normalizedCountryName) && abbr === normalizedInput) {
        return 0.9;
      }
    }

    return 0; // No abbreviation match
  }

  private static data: ICountry[] = [
    {
      name: 'Afghanistan',
      value: 'AF',
    },
    {
      name: '\u00c5land Islands',
      value: 'AX',
    },
    {
      name: 'Albania',
      value: 'AL',
    },
    {
      name: 'Algeria',
      value: 'DZ',
    },
    {
      name: 'American Samoa',
      value: 'AS',
    },
    {
      name: 'Andorra',
      value: 'AD',
    },
    {
      name: 'Angola',
      value: 'AO',
    },
    {
      name: 'Anguilla',
      value: 'AI',
    },
    {
      name: 'Antarctica',
      value: 'AQ',
    },
    {
      name: 'Antigua and Barbuda',
      value: 'AG',
    },
    {
      name: 'Argentina',
      value: 'AR',
    },
    {
      name: 'Armenia',
      value: 'AM',
    },
    {
      name: 'Aruba',
      value: 'AW',
    },
    {
      name: 'Australia',
      value: 'AU',
    },
    {
      name: 'Austria',
      value: 'AT',
    },
    {
      name: 'Azerbaijan',
      value: 'AZ',
    },
    {
      name: 'Bahamas',
      value: 'BS',
    },
    {
      name: 'Bahrain',
      value: 'BH',
    },
    {
      name: 'Bangladesh',
      value: 'BD',
    },
    {
      name: 'Barbados',
      value: 'BB',
    },
    {
      name: 'Belarus',
      value: 'BY',
    },
    {
      name: 'Belgium',
      value: 'BE',
    },
    {
      name: 'Belize',
      value: 'BZ',
    },
    {
      name: 'Benin',
      value: 'BJ',
    },
    {
      name: 'Bermuda',
      value: 'BM',
    },
    {
      name: 'Bhutan',
      value: 'BT',
    },
    {
      name: 'Bolivia',
      value: 'BO',
    },
    {
      name: 'Bonaire, Sint Eustatius and Saba',
      value: 'BQ',
    },
    {
      name: 'Bosnia and Herzegovina',
      value: 'BA',
    },
    {
      name: 'Botswana',
      value: 'BW',
    },
    {
      name: 'Bouvet Island',
      value: 'BV',
    },
    {
      name: 'Brazil',
      value: 'BR',
    },
    {
      name: 'British Indian Ocean Territory',
      value: 'IO',
    },
    {
      name: 'Brunei Darussalam',
      value: 'BN',
    },
    {
      name: 'Bulgaria',
      value: 'BG',
    },
    {
      name: 'Burkina Faso',
      value: 'BF',
    },
    {
      name: 'Burundi',
      value: 'BI',
    },
    {
      name: 'Cabo Verde',
      value: 'CV',
    },
    {
      name: 'Cambodia',
      value: 'KH',
    },
    {
      name: 'Cameroon',
      value: 'CM',
    },
    {
      name: 'Canada',
      value: 'CA',
    },
    {
      name: 'Cayman Islands',
      value: 'KY',
    },
    {
      name: 'Central African Republic',
      value: 'CF',
    },
    {
      name: 'Chad',
      value: 'TD',
    },
    {
      name: 'Chile',
      value: 'CL',
    },
    {
      name: 'China',
      value: 'CN',
    },
    {
      name: 'Christmas Island',
      value: 'CX',
    },
    {
      name: 'Cocos (Keeling) Islands',
      value: 'CC',
    },
    {
      name: 'Colombia',
      value: 'CO',
    },
    {
      name: 'Comoros',
      value: 'KM',
    },
    {
      name: 'Congo',
      value: 'CG',
    },
    {
      name: 'Congo (Democratic Republic of the)',
      value: 'CD',
    },
    {
      name: 'Cook Islands',
      value: 'CK',
    },
    {
      name: 'Costa Rica',
      value: 'CR',
    },
    {
      name: 'Croatia',
      value: 'HR',
    },
    {
      name: 'Cuba',
      value: 'CU',
    },
    {
      name: 'Cura\u00e7ao',
      value: 'CW',
    },
    {
      name: 'Cyprus',
      value: 'CY',
    },
    {
      name: 'Czechia',
      value: 'CZ',
    },
    {
      name: "C\u00f4te d'Ivoire",
      value: 'CI',
    },
    {
      name: 'Denmark',
      value: 'DK',
    },
    {
      name: 'Djibouti',
      value: 'DJ',
    },
    {
      name: 'Dominica',
      value: 'DM',
    },
    {
      name: 'Dominican Republic',
      value: 'DO',
    },
    {
      name: 'Ecuador',
      value: 'EC',
    },
    {
      name: 'Egypt',
      value: 'EG',
    },
    {
      name: 'El Salvador',
      value: 'SV',
    },
    {
      name: 'Equatorial Guinea',
      value: 'GQ',
    },
    {
      name: 'Eritrea',
      value: 'ER',
    },
    {
      name: 'Estonia',
      value: 'EE',
    },
    {
      name: 'Eswatini',
      value: 'SZ',
    },
    {
      name: 'Ethiopia',
      value: 'ET',
    },
    {
      name: 'Falkland Islands',
      value: 'FK',
    },
    {
      name: 'Faroe Islands',
      value: 'FO',
    },
    {
      name: 'Fiji',
      value: 'FJ',
    },
    {
      name: 'Finland',
      value: 'FI',
    },
    {
      name: 'France',
      value: 'FR',
    },
    {
      name: 'French Guiana',
      value: 'GF',
    },
    {
      name: 'French Polynesia',
      value: 'PF',
    },
    {
      name: 'French Southern Territories',
      value: 'TF',
    },
    {
      name: 'Gabon',
      value: 'GA',
    },
    {
      name: 'Gambia',
      value: 'GM',
    },
    {
      name: 'Georgia',
      value: 'GE',
    },
    {
      name: 'Germany',
      value: 'DE',
    },
    {
      name: 'Ghana',
      value: 'GH',
    },
    {
      name: 'Gibraltar',
      value: 'GI',
    },
    {
      name: 'Greece',
      value: 'GR',
    },
    {
      name: 'Greenland',
      value: 'GL',
    },
    {
      name: 'Grenada',
      value: 'GD',
    },
    {
      name: 'Guadeloupe',
      value: 'GP',
    },
    {
      name: 'Guam',
      value: 'GU',
    },
    {
      name: 'Guatemala',
      value: 'GT',
    },
    {
      name: 'Guernsey',
      value: 'GG',
    },
    {
      name: 'Guinea',
      value: 'GN',
    },
    {
      name: 'Guinea-Bissau',
      value: 'GW',
    },
    {
      name: 'Guyana',
      value: 'GY',
    },
    {
      name: 'Haiti',
      value: 'HT',
    },
    {
      name: 'Heard Island and McDonald Islands',
      value: 'HM',
    },
    {
      name: 'Holy See',
      value: 'VA',
    },
    {
      name: 'Honduras',
      value: 'HN',
    },
    {
      name: 'Hong Kong',
      value: 'HK',
    },
    {
      name: 'Hungary',
      value: 'HU',
    },
    {
      name: 'Iceland',
      value: 'IS',
    },
    {
      name: 'India',
      value: 'IN',
    },
    {
      name: 'Indonesia',
      value: 'ID',
    },
    {
      name: 'Iran',
      value: 'IR',
    },
    {
      name: 'Iraq',
      value: 'IQ',
    },
    {
      name: 'Ireland',
      value: 'IE',
    },
    {
      name: 'Isle of Man',
      value: 'IM',
    },
    {
      name: 'Israel',
      value: 'IL',
    },
    {
      name: 'Italy',
      value: 'IT',
    },
    {
      name: 'Jamaica',
      value: 'JM',
    },
    {
      name: 'Japan',
      value: 'JP',
    },
    {
      name: 'Jersey',
      value: 'JE',
    },
    {
      name: 'Jordan',
      value: 'JO',
    },
    {
      name: 'Kazakhstan',
      value: 'KZ',
    },
    {
      name: 'Kenya',
      value: 'KE',
    },
    {
      name: 'Kiribati',
      value: 'KI',
    },
    {
      name: "Korea (Democratic People's Republic of)",
      value: 'KP',
    },
    {
      name: 'Korea (Republic of)',
      value: 'KR',
    },
    {
      name: 'Kuwait',
      value: 'KW',
    },
    {
      name: 'Kyrgyzstan',
      value: 'KG',
    },
    {
      name: "Lao People's Democratic Republic",
      value: 'LA',
    },
    {
      name: 'Latvia',
      value: 'LV',
    },
    {
      name: 'Lebanon',
      value: 'LB',
    },
    {
      name: 'Lesotho',
      value: 'LS',
    },
    {
      name: 'Liberia',
      value: 'LR',
    },
    {
      name: 'Libya',
      value: 'LY',
    },
    {
      name: 'Liechtenstein',
      value: 'LI',
    },
    {
      name: 'Lithuania',
      value: 'LT',
    },
    {
      name: 'Luxembourg',
      value: 'LU',
    },
    {
      name: 'Macao',
      value: 'MO',
    },
    {
      name: 'Madagascar',
      value: 'MG',
    },
    {
      name: 'Malawi',
      value: 'MW',
    },
    {
      name: 'Malaysia',
      value: 'MY',
    },
    {
      name: 'Maldives',
      value: 'MV',
    },
    {
      name: 'Mali',
      value: 'ML',
    },
    {
      name: 'Malta',
      value: 'MT',
    },
    {
      name: 'Marshall Islands',
      value: 'MH',
    },
    {
      name: 'Martinique',
      value: 'MQ',
    },
    {
      name: 'Mauritania',
      value: 'MR',
    },
    {
      name: 'Mauritius',
      value: 'MU',
    },
    {
      name: 'Mayotte',
      value: 'YT',
    },
    {
      name: 'Mexico',
      value: 'MX',
    },
    {
      name: 'Micronesia (Federated States of)',
      value: 'FM',
    },
    {
      name: 'Moldova (Republic of)',
      value: 'MD',
    },
    {
      name: 'Monaco',
      value: 'MC',
    },
    {
      name: 'Mongolia',
      value: 'MN',
    },
    {
      name: 'Montenegro',
      value: 'ME',
    },
    {
      name: 'Montserrat',
      value: 'MS',
    },
    {
      name: 'Morocco',
      value: 'MA',
    },
    {
      name: 'Mozambique',
      value: 'MZ',
    },
    {
      name: 'Myanmar',
      value: 'MM',
    },
    {
      name: 'Namibia',
      value: 'NA',
    },
    {
      name: 'Nauru',
      value: 'NR',
    },
    {
      name: 'Nepal',
      value: 'NP',
    },
    {
      name: 'Netherlands',
      value: 'NL',
    },
    {
      name: 'New Caledonia',
      value: 'NC',
    },
    {
      name: 'New Zealand',
      value: 'NZ',
    },
    {
      name: 'Nicaragua',
      value: 'NI',
    },
    {
      name: 'Niger',
      value: 'NE',
    },
    {
      name: 'Nigeria',
      value: 'NG',
    },
    {
      name: 'Niue',
      value: 'NU',
    },
    {
      name: 'Norfolk Island',
      value: 'NF',
    },
    {
      name: 'North Macedonia',
      value: 'MK',
    },
    {
      name: 'Northern Mariana Islands',
      value: 'MP',
    },
    {
      name: 'Norway',
      value: 'NO',
    },
    {
      name: 'Oman',
      value: 'OM',
    },
    {
      name: 'Pakistan',
      value: 'PK',
    },
    {
      name: 'Palau',
      value: 'PW',
    },
    {
      name: 'Palestine, State of',
      value: 'PS',
    },
    {
      name: 'Panama',
      value: 'PA',
    },
    {
      name: 'Papua New Guinea',
      value: 'PG',
    },
    {
      name: 'Paraguay',
      value: 'PY',
    },
    {
      name: 'Peru',
      value: 'PE',
    },
    {
      name: 'Philippines',
      value: 'PH',
    },
    {
      name: 'Pitcairn',
      value: 'PN',
    },
    {
      name: 'Poland',
      value: 'PL',
    },
    {
      name: 'Portugal',
      value: 'PT',
    },
    {
      name: 'Puerto Rico',
      value: 'PR',
    },
    {
      name: 'Qatar',
      value: 'QA',
    },
    {
      name: 'R\u00e9union',
      value: 'RE',
    },
    {
      name: 'Romania',
      value: 'RO',
    },
    {
      name: 'Russian Federation',
      value: 'RU',
    },
    {
      name: 'Rwanda',
      value: 'RW',
    },
    {
      name: 'Saint Barth\u00e9lemy',
      value: 'BL',
    },
    {
      name: 'Saint Helena, Ascension and Tristan da Cunha',
      value: 'SH',
    },
    {
      name: 'Saint Kitts and Nevis',
      value: 'KN',
    },
    {
      name: 'Saint Lucia',
      value: 'LC',
    },
    {
      name: 'Saint Martin (French part)',
      value: 'MF',
    },
    {
      name: 'Saint Pierre and Miquelon',
      value: 'PM',
    },
    {
      name: 'Saint Vincent and the Grenadines',
      value: 'VC',
    },
    {
      name: 'Samoa',
      value: 'WS',
    },
    {
      name: 'San Marino',
      value: 'SM',
    },
    {
      name: 'Sao Tome and Principe',
      value: 'ST',
    },
    {
      name: 'Saudi Arabia',
      value: 'SA',
    },
    {
      name: 'Senegal',
      value: 'SN',
    },
    {
      name: 'Serbia',
      value: 'RS',
    },
    {
      name: 'Seychelles',
      value: 'SC',
    },
    {
      name: 'Sierra Leone',
      value: 'SL',
    },
    {
      name: 'Singapore',
      value: 'SG',
    },
    {
      name: 'Sint Maarten (Dutch part)',
      value: 'SX',
    },
    {
      name: 'Slovakia',
      value: 'SK',
    },
    {
      name: 'Slovenia',
      value: 'SI',
    },
    {
      name: 'Solomon Islands',
      value: 'SB',
    },
    {
      name: 'Somalia',
      value: 'SO',
    },
    {
      name: 'South Africa',
      value: 'ZA',
    },
    {
      name: 'South Georgia and the South Sandwich Islands',
      value: 'GS',
    },
    {
      name: 'South Sudan',
      value: 'SS',
    },
    {
      name: 'Spain',
      value: 'ES',
    },
    {
      name: 'Sri Lanka',
      value: 'LK',
    },
    {
      name: 'Sudan',
      value: 'SD',
    },
    {
      name: 'Suriname',
      value: 'SR',
    },
    {
      name: 'Svalbard and Jan Mayen',
      value: 'SJ',
    },
    {
      name: 'Sweden',
      value: 'SE',
    },
    {
      name: 'Switzerland',
      value: 'CH',
    },
    {
      name: 'Syrian Arab Republic',
      value: 'SY',
    },
    {
      name: 'Taiwan, Province of China',
      value: 'TW',
    },
    {
      name: 'Tajikistan',
      value: 'TJ',
    },
    {
      name: 'Tanzania, United Republic of',
      value: 'TZ',
    },
    {
      name: 'Thailand',
      value: 'TH',
    },
    {
      name: 'Timor-Leste',
      value: 'TL',
    },
    {
      name: 'Togo',
      value: 'TG',
    },
    {
      name: 'Tokelau',
      value: 'TK',
    },
    {
      name: 'Tonga',
      value: 'TO',
    },
    {
      name: 'Trinidad and Tobago',
      value: 'TT',
    },
    {
      name: 'Tunisia',
      value: 'TN',
    },
    {
      name: 'Turkey',
      value: 'TR',
    },
    {
      name: 'Turkmenistan',
      value: 'TM',
    },
    {
      name: 'Tuvalu',
      value: 'TV',
    },
    {
      name: 'Uganda',
      value: 'UG',
    },
    {
      name: 'Ukraine',
      value: 'UA',
    },
    {
      name: 'United Arab Emirates',
      value: 'AE',
    },
    {
      name: 'United Kingdom of Great Britain and Northern Ireland',
      value: 'GB',
    },
    {
      name: 'United States of America',
      value: 'US',
    },
    {
      name: 'Uruguay',
      value: 'UY',
    },
    {
      name: 'Uzbekistan',
      value: 'UZ',
    },
    {
      name: 'Vanuatu',
      value: 'VU',
    },
    {
      name: 'Venezuela (Bolivarian Republic of)',
      value: 'VE',
    },
    {
      name: 'Viet Nam',
      value: 'VN',
    },
    {
      name: 'Western Sahara',
      value: 'EH',
    },
    {
      name: 'Yemen',
      value: 'YE',
    },
    {
      name: 'Zambia',
      value: 'ZM',
    },
    {
      name: 'Zimbabwe',
      value: 'ZW',
    },
  ];
}
