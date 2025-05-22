import { Router, json } from "express";
const router = Router();
import axios from "axios";
import { Agent } from "http";
import { Agent as _Agent } from "https";

const httpClient = axios.create({
  httpAgent: new Agent({ keepAlive: true }),
  httpsAgent: new _Agent({ keepAlive: true }),
  timeout: 10000,
});

router.use(json());

/**
 * @route POST /api/maps
 * @description Get location data from Google Maps URL
 * @access Public
 */
router.post("/maps", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }

    // Resolve short URL to full URL first
    const fullUrl = await resolveShortUrl(url);

    // Extract coordinates (they're always in the URL)
    const coordsMatch = fullUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (!coordsMatch) {
      throw new Error("Could not extract coordinates from URL");
    }
    const [_, lat, lng] = coordsMatch;
    const numericLat = parseFloat(lat);
    const numericLng = parseFloat(lng);

    // Try to get place details (name, address) using place ID
    let placeDetails = {
      geometry: { location: { lat: numericLat, lng: numericLng } },
      name: "Location",
      formatted_address: null,
    };

    try {
      const placeId = await getPlaceIdFromUrl(fullUrl);
      if (placeId) {
        placeDetails = await getPlaceDetails(placeId);
      }
    } catch (e) {
      console.warn(
        "Place details lookup failed, using coordinate fallback:",
        e.message
      );
    }

    // Get address (try reverse geocoding if place details didn't provide it)
    const address =
      placeDetails.formatted_address ||
      (await getFullAddress(numericLat, numericLng));
    const staticMapUrl = generateStaticMap(numericLat, numericLng);

    res.set(
      "Cache-Control",
      "public, max-age=86400, stale-while-revalidate=3600"
    );

    return res.json({
      name: placeDetails.name || "Location",
      address: address || `Near ${numericLat}, ${numericLng}`,
      coordinates: { lat: numericLat, lng: numericLng },
      staticMapUrl,
      placeId: placeDetails.place_id || null,
    });
  } catch (error) {
    console.error("Location service error:", error.message);
    return res.status(500).json({
      error: error.message || "Location service unavailable",
      ...(process.env.NODE_ENV === "development" && { details: error.stack }),
    });
  }
});

async function resolveShortUrl(url) {
  // If it's not a short URL, return as is
  if (!url.includes("goo.gl") && !url.includes("maps.app.goo.gl")) {
    return url;
  }

  try {
    const response = await httpClient.get(url, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400, // Allow redirect status codes
    });

    // If we get a redirect, return the location header
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.location
    ) {
      return response.headers.location;
    }

    // If no redirect (unlikely), return original URL
    return url;
  } catch (error) {
    if (
      error.response &&
      error.response.status >= 300 &&
      error.response.status < 400 &&
      error.response.headers.location
    ) {
      return error.response.headers.location;
    }
    console.warn("Failed to resolve short URL, using original:", error.message);
    return url;
  }
}

async function getPlaceIdFromUrl(url) {
  try {
    // 1. First try to get coordinates from URL
    const coordsMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (coordsMatch) {
      const [_, lat, lng] = coordsMatch;
      // Try to get place ID from coordinates
      const placeId = await getPlaceIdFromCoordinates(lat, lng);
      if (placeId) return placeId;
    }

    // 2. If no coordinates or place ID lookup failed, try text search
    const searchText =
      new URL(url).pathname
        .split("/")
        .filter((part) => part.trim().length > 0)
        .pop() || "Location";

    return await getPlaceIdFromTextSearch(searchText);
  } catch (error) {
    console.warn(
      "Place ID lookup failed, using coordinate fallback:",
      error.message
    );
    return null; // Return null to indicate we should use coordinates directly
  }
}

async function getPlaceIdFromCoordinates(lat, lng) {
  const response = await httpClient.get(
    "https://maps.googleapis.com/maps/api/geocode/json",
    {
      params: {
        latlng: `${lat},${lng}`,
        key: process.env.GOOGLE_MAPS_API_KEY,
        language: "en",
      },
    }
  );

  if (response.data.status === "OK" && response.data.results.length > 0) {
    return response.data.results[0].place_id;
  }
  return null;
}

function isValidPlaceId(placeId) {
  return (
    typeof placeId === "string" &&
    (/^[a-zA-Z0-9_-]{27,}$/.test(placeId) || // Standard place IDs
      /^ChIJ[a-zA-Z0-9_-]+$/.test(placeId) || // Place IDs starting with ChIJ
      /^E[a-zA-Z0-9_-]+$/.test(placeId) || // Place IDs starting with E
      /^[0-9a-fA-F]+:[0-9a-fA-F]+$/.test(placeId)) // Compound IDs with colon
  );
}

async function getPlaceIdFromTextSearch(searchText) {
  const response = await httpClient.get(
    "https://maps.googleapis.com/maps/api/place/findplacefromtext/json",
    {
      params: {
        input: decodeURIComponent(searchText.replace(/\+/g, " ")),
        inputtype: "textquery",
        fields: "place_id",
        key: process.env.GOOGLE_MAPS_API_KEY,
        language: "en",
      },
    }
  );

  if (response.data.status !== "OK" || !response.data.candidates?.length) {
    throw new Error(response.data.error_message || "Place not found");
  }
  return response.data.candidates[0].place_id;
}

async function getPlaceDetails(placeId) {
  if (!isValidPlaceId(placeId)) {
    throw new Error(`Invalid place ID format: ${placeId}`);
  }

  const response = await httpClient.get(
    "https://maps.googleapis.com/maps/api/place/details/json",
    {
      params: {
        place_id: placeId,
        fields: "name,geometry,formatted_address,place_id",
        key: process.env.GOOGLE_MAPS_API_KEY,
        language: "en",
      },
    }
  );

  if (response.data.status !== "OK") {
    throw new Error(response.data.error_message || "Invalid place details");
  }
  return response.data.result;
}

async function getFullAddress(lat, lng) {
  const response = await httpClient.get(
    "https://maps.googleapis.com/maps/api/geocode/json",
    {
      params: {
        latlng: `${lat},${lng}`,
        key: process.env.GOOGLE_MAPS_API_KEY,
        language: "en",
      },
    }
  );

  if (response.data.status !== "OK") {
    console.warn("Geocoding failed, using place address instead");
    return null;
  }
  return response.data.results[0].formatted_address;
}

function generateStaticMap(lat, lng) {
  const params = new URLSearchParams({
    center: `${lat},${lng}`,
    zoom: "15",
    size: "600x300",
    maptype: "roadmap",
    markers: `color:red|${lat},${lng}`,
    key: process.env.GOOGLE_MAPS_API_KEY,
    scale: "2",
  });

  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}

export default router;
