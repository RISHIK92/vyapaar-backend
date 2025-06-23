import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { locationCache } from "../index.js";

const prisma = new PrismaClient();

export default async function getFilteredBottomBanners(
  userPincode,
  maxResults = 10
) {
  const allBanners = await getAllEligibleBottomBanners();

  // If no pincode provided, return all banners randomly
  if (!userPincode) {
    console.log(
      "No pincode provided - returning random banners from all available"
    );
    return shuffleArray(allBanners).slice(0, maxResults);
  }

  // Get enhanced user location data
  const userLocation = await getEnhancedLocationData(userPincode);

  if (!userLocation) {
    console.log(
      `Could not determine location for pincode: ${userPincode} - returning all banners`
    );
    return shuffleArray(allBanners).slice(0, maxResults);
  }

  console.log(`User location data for ${userPincode}:`, {
    district: userLocation.district,
    city: userLocation.city,
    state: userLocation.state,
    coordinates: userLocation.coordinates,
  });

  // Categorize banners by location relevance
  const areaBanners = []; // Same district/area
  const nearbyBanners = []; // Within 55km in same state
  const globalBanners = []; // Pincode 000000 - always show
  const fallbackBanners = []; // No location data or no location restrictions

  for (const banner of allBanners) {
    // Special case: pincode 000000 means global banner - always show
    if (banner.pincode === 0 || banner.pincode === "000000") {
      globalBanners.push({ ...banner, locationScore: 100 }); // High priority for global banners
      console.log(`Global banner ${banner.id} added (pincode: 000000)`);
      continue;
    }

    const bannerLocation = await getBannerLocationData(banner);

    // If banner has no location data, check if it has any location restrictions
    if (!bannerLocation) {
      // Only include banners without ANY location restrictions in fallback
      if (!banner.locationUrl && !banner.pincode) {
        fallbackBanners.push({ ...banner, locationScore: 50 }); // Medium priority for unrestricted banners
        console.log(
          `Unrestricted banner ${banner.id} added to fallback (no location data)`
        );
      } else {
        console.log(
          `Banner ${banner.id} skipped (has location fields but couldn't resolve location)`
        );
      }
      continue;
    }

    // Check if banner is in the same area (district match)
    const isInSameArea = isBannerInUserArea(userLocation, bannerLocation);

    if (isInSameArea) {
      // Calculate score for sorting within area
      const score = calculateBannerLocationScore(
        userLocation,
        bannerLocation,
        banner
      );
      areaBanners.push({ ...banner, locationScore: score });
      console.log(
        `✓ Area banner ${banner.id}: ${
          bannerLocation?.district || "No district"
        } (Score: ${score})`
      );
    } else {
      // Check if banner is within 55km radius and in same state
      if (
        userLocation.coordinates &&
        bannerLocation.coordinates &&
        userLocation.state &&
        bannerLocation.state &&
        userLocation.state.toLowerCase() === bannerLocation.state.toLowerCase()
      ) {
        const distance = calculateDistance(
          userLocation.coordinates.lat,
          userLocation.coordinates.lng,
          bannerLocation.coordinates.lat,
          bannerLocation.coordinates.lng
        );

        // Check 55km radius within same state
        if (distance <= 55) {
          banner.distance = distance;
          nearbyBanners.push({ ...banner, distance });
          console.log(
            `→ Nearby banner ${banner.id}: ${distance.toFixed(
              1
            )}km away (same state)`
          );
        } else {
          console.log(
            `Banner ${
              banner.id
            } excluded - outside 55km radius (${distance.toFixed(1)}km > 55km)`
          );
        }
      } else {
        // No coordinates available or different state, add to fallback if no location restrictions
        if (!banner.locationUrl && !banner.pincode) {
          fallbackBanners.push({ ...banner, locationScore: 25 });
        } else {
          console.log(
            `Banner ${banner.id} excluded - different state or no coordinates`
          );
        }
      }
    }
  }

  console.log(
    `Banner categorization - Global: ${globalBanners.length}, Area: ${areaBanners.length}, Nearby: ${nearbyBanners.length}, Fallback: ${fallbackBanners.length}`
  );

  // STRATEGY: Global banners always included, then area-first approach
  let selectedBanners = [];

  // 0. ALWAYS INCLUDE: Global banners (pincode 000000)
  selectedBanners.push(...globalBanners);

  const remainingSlots = maxResults - selectedBanners.length;

  if (remainingSlots > 0) {
    // 1. PRIORITY: Use area banners if available
    if (areaBanners.length > 0) {
      console.log(
        `Found ${areaBanners.length} banners in user's area - adding area banners`
      );

      // Sort area banners by score (highest first)
      areaBanners.sort((a, b) => b.locationScore - a.locationScore);
      selectedBanners.push(...areaBanners.slice(0, remainingSlots));
    } else {
      console.log(
        "No banners found in user's area - falling back to nearest banners within 55km"
      );

      // 2. FALLBACK: Use nearest banners within 55km sorted by distance
      if (nearbyBanners.length > 0) {
        // Sort by distance (nearest first)
        nearbyBanners.sort((a, b) => a.distance - b.distance);
        selectedBanners.push(...nearbyBanners.slice(0, remainingSlots));

        console.log(
          `Using ${Math.min(
            nearbyBanners.length,
            remainingSlots
          )} nearest banners within 55km`
        );
      } else {
        // 3. LAST RESORT: Use fallback banners (banners with no location restrictions)
        console.log(
          "No nearby banners found within 55km - using unrestricted banners"
        );
        selectedBanners.push(...fallbackBanners.slice(0, remainingSlots));
      }
    }
  }

  console.log(`Final banner selection - Total: ${selectedBanners.length}`);

  // Light shuffle to avoid predictable ordering while maintaining relevance
  // Keep global banners at the top, shuffle the rest
  const globalCount = globalBanners.length;
  const globalPart = selectedBanners.slice(0, globalCount);
  const otherPart = shuffleArray(selectedBanners.slice(globalCount));

  return [...globalPart, ...otherPart].slice(0, maxResults);
}

async function getAllEligibleBottomBanners() {
  const currentDate = new Date();

  return await prisma.bottomBanner.findMany({
    where: {
      active: true,
      OR: [
        { expiresAt: null }, // No expiration
        { expiresAt: { gte: currentDate } }, // Not expired
      ],
    },
    orderBy: { createdAt: "desc" },
  });
}

async function getBannerLocationData(banner) {
  try {
    // Special case: pincode 000000 means global banner
    if (banner.pincode === 0 || banner.pincode === "000000") {
      return null; // Global banners don't need location data
    }

    // Check cache first
    const cacheKey = `bottom_banner_location_${banner.id}`;
    const cachedLocation = locationCache.get(cacheKey);
    if (cachedLocation) return cachedLocation;

    let coordinates = null;
    let locationData = null;

    // Priority 1: Extract from Google Maps URL (locationUrl)
    if (banner.locationUrl) {
      coordinates = await extractCoordsFromUrl(banner.locationUrl);
      if (coordinates) {
        locationData = await getLocationDataFromCoordinates(
          coordinates.lat,
          coordinates.lng
        );
        console.log(
          `✓ Got location data from locationUrl for banner ${banner.id}`
        );
      }
    }

    // Priority 2: Geocode from pincode
    if (!locationData && banner.pincode) {
      const pincodeLocation = await getEnhancedLocationData(
        banner.pincode.toString()
      );
      if (pincodeLocation) {
        locationData = pincodeLocation;
        console.log(
          `✓ Got location data from pincode ${banner.pincode} for banner ${banner.id}`
        );
      }
    }

    if (locationData) {
      // Cache the result
      locationCache.set(cacheKey, locationData);
      console.log(`Cached location data for banner ${banner.id}:`, {
        district: locationData.district,
        city: locationData.city,
        coordinates: locationData.coordinates,
      });
    } else {
      console.log(`⚠️ Could not determine location for banner ${banner.id}`);
    }

    return locationData;
  } catch (error) {
    console.error(
      `Error getting location data for banner ${banner.id}:`,
      error.message
    );
    return null;
  }
}

export function formatBottomBanners(banners) {
  return banners.map((banner) => {
    return {
      id: banner.id,
      imageUrl: banner.Image || "/placeholder-banner.jpg",
      title: `Banner ${banner.id}`, // You can customize this based on your needs
      subtitle:
        banner.pincode === 0 || banner.pincode === "000000"
          ? "Featured Nationwide"
          : `Available in ${
              banner.pincode ? `PIN: ${banner.pincode}` : "your area"
            }`,
      link: banner.ListingUrl || "#",
      youtubeUrl: banner.youtubeUrl,
      isGlobal: banner.pincode === 0 || banner.pincode === "000000",
      locationScore: banner.locationScore || 0,
      expiresAt: banner.expiresAt,
      pincode: banner.pincode,
    };
  });
}

function isBannerInUserArea(userLocation, bannerLocation) {
  if (!userLocation || !bannerLocation) return false;

  // Primary check: Same district
  if (userLocation.district && bannerLocation.district) {
    if (
      userLocation.district.toLowerCase() ===
      bannerLocation.district.toLowerCase()
    ) {
      return true;
    }
  }

  // Secondary check: Same city (if no district match)
  if (userLocation.city && bannerLocation.city) {
    if (userLocation.city.toLowerCase() === bannerLocation.city.toLowerCase()) {
      return true;
    }
  }

  // Tertiary check: Very close proximity (within 15km in same state)
  if (
    userLocation.coordinates &&
    bannerLocation.coordinates &&
    userLocation.state &&
    bannerLocation.state &&
    userLocation.state.toLowerCase() === bannerLocation.state.toLowerCase()
  ) {
    const distance = calculateDistance(
      userLocation.coordinates.lat,
      userLocation.coordinates.lng,
      bannerLocation.coordinates.lat,
      bannerLocation.coordinates.lng
    );

    // Consider within 55km as "same area" if in same state
    return distance <= 55;
  }

  return false;
}

function calculateBannerLocationScore(userLocation, bannerLocation, banner) {
  if (!bannerLocation) return 0;

  let score = 100; // Base score for being in area

  const bonusWeights = {
    exactCityMatch: 50,
    subDistrictMatch: 30,
    proximityBonus: 20,
  };

  // Bonus for exact city match
  if (
    userLocation.city &&
    bannerLocation.city &&
    userLocation.city.toLowerCase() === bannerLocation.city.toLowerCase()
  ) {
    score += bonusWeights.exactCityMatch;
    console.log(`✓ City match for banner ${banner.id}: ${bannerLocation.city}`);
  }

  // Bonus for sub-district match
  if (
    userLocation.subDistrict &&
    bannerLocation.subDistrict &&
    userLocation.subDistrict.toLowerCase() ===
      bannerLocation.subDistrict.toLowerCase()
  ) {
    score += bonusWeights.subDistrictMatch;
    console.log(
      `✓ Sub-district match for banner ${banner.id}: ${bannerLocation.subDistrict}`
    );
  }

  // Proximity bonus within area
  if (userLocation.coordinates && bannerLocation.coordinates) {
    const distance = calculateDistance(
      userLocation.coordinates.lat,
      userLocation.coordinates.lng,
      bannerLocation.coordinates.lat,
      bannerLocation.coordinates.lng
    );

    banner.distance = distance;
    console.log(`Distance for banner ${banner.id}: ${distance.toFixed(2)}km`);

    // Proximity bonus (within area)
    if (distance <= 5) score += bonusWeights.proximityBonus;
    else if (distance <= 10) score += bonusWeights.proximityBonus * 0.8;
    else if (distance <= 20) score += bonusWeights.proximityBonus * 0.6;
  }

  return Math.round(score);
}

// Distance calculation function (Haversine formula)
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Get detailed location data from coordinates
async function getLocationDataFromCoordinates(lat, lng) {
  try {
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json`,
      {
        params: {
          latlng: `${lat},${lng}`,
          key: process.env.GOOGLE_MAPS_API_KEY,
        },
      }
    );

    if (response.data.status === "OK" && response.data.results?.length > 0) {
      const result = response.data.results[0];

      return {
        coordinates: { lat, lng },
        district: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_2"
        ),
        subDistrict: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_3"
        ),
        city: extractFromAddressComponents(
          result.address_components,
          "locality"
        ),
        state: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_1"
        ),
        pincode: extractFromAddressComponents(
          result.address_components,
          "postal_code"
        ),
        formattedAddress: result.formatted_address,
      };
    }

    return null;
  } catch (error) {
    console.error(
      `Failed to get location data for coordinates ${lat}, ${lng}:`,
      error.message
    );
    return null;
  }
}

// Enhanced location data extraction for user pincode
async function getEnhancedLocationData(pincode) {
  try {
    // Check cache first
    const cacheKey = `enhanced_location_${pincode}`;
    const cachedLocation = locationCache.get(cacheKey);
    if (cachedLocation) return cachedLocation;

    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json`,
      {
        params: {
          address: pincode,
          components: "country:IN",
          key: process.env.GOOGLE_MAPS_API_KEY,
        },
      }
    );

    if (response.data.status === "OK" && response.data.results?.length > 0) {
      const result = response.data.results[0];

      const locationData = {
        coordinates: result.geometry.location,
        district: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_2"
        ),
        subDistrict: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_3"
        ),
        city: extractFromAddressComponents(
          result.address_components,
          "locality"
        ),
        state: extractFromAddressComponents(
          result.address_components,
          "administrative_area_level_1"
        ),
        pincode: extractFromAddressComponents(
          result.address_components,
          "postal_code"
        ),
        formattedAddress: result.formatted_address,
      };

      // Cache the result
      locationCache.set(cacheKey, locationData);

      return locationData;
    }

    return null;
  } catch (error) {
    console.error(`Enhanced location lookup failed for ${pincode}:`, error);
    return null;
  }
}

// Extract specific component from Google's address components
function extractFromAddressComponents(addressComponents, targetType) {
  const component = addressComponents.find((comp) =>
    comp.types.includes(targetType)
  );
  return component?.long_name || null;
}

function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function extractCoordsFromUrl(url) {
  try {
    // Handle shortened URLs
    if (url.includes("goo.gl") || url.includes("maps.app.goo.gl")) {
      url = await resolveShortUrl(url);
    }

    // Method 1: Extract from @ parameter
    if (url.includes("@")) {
      const parts = url.split("@")[1].split(",");
      if (parts.length >= 2) {
        const lat = parseFloat(parts[0]);
        const lng = parseFloat(parts[1]);
        if (!isNaN(lat) && !isNaN(lng)) {
          return { lat, lng };
        }
      }
    }

    // Method 2: Extract from query parameters
    const urlObj = new URL(url);
    const qParam = urlObj.searchParams.get("q");
    if (qParam) {
      const coords = qParam.split(",");
      if (coords.length === 2) {
        const lat = parseFloat(coords[0]);
        const lng = parseFloat(coords[1]);
        if (!isNaN(lat) && !isNaN(lng)) {
          return { lat, lng };
        }
      }
    }

    // Method 3: Extract from place format (!3d and !4d)
    const placeMatch = url.match(/!3d([\d.-]+)!4d([\d.-]+)/);
    if (placeMatch) {
      const lat = parseFloat(placeMatch[1]);
      const lng = parseFloat(placeMatch[2]);
      if (!isNaN(lat) && !isNaN(lng)) {
        return { lat, lng };
      }
    }

    console.log(`Could not extract coordinates from URL: ${url}`);
    return null;
  } catch (error) {
    console.error(`Error extracting coords from URL ${url}:`, error.message);
    return null;
  }
}

// Enhanced URL resolution with better error handling
async function resolveShortUrl(url) {
  try {
    const response = await axios.head(url, {
      maxRedirects: 10,
      timeout: 5000,
      validateStatus: null,
    });

    const resolvedUrl =
      response.request?.res?.responseUrl || response.headers?.location || url;

    console.log(`Resolved ${url} -> ${resolvedUrl}`);
    return resolvedUrl;
  } catch (error) {
    console.error(`Error resolving short URL ${url}:`, error.message);
    return url;
  }
}
