const fetch = require('node-fetch');
const router = require('express').Router();
const { param, query } = require('express-validator');
const logger = require('../utils/logger');
const redis = require('../utils/redisclient');
const apiErrorReporter = require('../utils/apierrorreporter');

const CACHE_TIME = 60 * 60; // An hour in seconds.
const redisClient = redis.getClient();

const getWeatherKey = (locationId) => redis.getKeyName('weather', locationId);

// This should also optionally take a withDetails request parameter.
router.get(
  '/location/:locationId',
  [
    param('locationId').isInt({ min: 1 }),
    query('withDetails').isBoolean().optional(),
    apiErrorReporter,
  ],
  async (req, res, next) => {
    const { locationId } = req.params;
    const { withDetails } = req.query;

    const locationKey = redis.getKeyName('locations', locationId);

    const pipeline = redisClient.pipeline();
    pipeline.hgetall(locationKey);

    if (withDetails) {
      const locationDetailsKey = redis.getKeyName('locationdetails', locationId);
      pipeline.call('JSON.GET', locationDetailsKey);
    }

    const details = await pipeline.exec();
    const locationOverview = details[0][1];
    let response;

    if (withDetails) {
      const locationDetails = JSON.parse(details[1][1]);
      delete locationDetails.id;

      response = {
        ...locationOverview,
        ...locationDetails,
      };
    } else {
      response = locationOverview;
    }

    res.status(200).json(response);
  },
);

// This should also optionally take a sections request parameter to
// selectively retrieve part of the JSON.
router.get(
  '/location/:locationId/details',
  [
    param('locationId').isInt({ min: 1 }),
    query('sections').isString().optional().custom((value, { req }) => {
      const { sections } = req.query;
      const validSections = ['socials', 'website', 'description', 'phone', 'hours'];
      const arrayOfSections = sections.split(',');

      for (const str of arrayOfSections) {
        if (!validSections.includes(str)) {
          throw new Error(`Invalid value ${str} for sections.`);
        }
      }

      return true;
    }),
    apiErrorReporter,
  ],
  async (req, res, next) => {
    const { locationId } = req.params;
    const { sections } = req.query;
    const locationDetailsKey = redis.getKeyName('locationdetails', locationId);

    let jsonPath = ['.'];
    if (sections) {
      jsonPath = sections.split(',');
    }

    const locationDetails = JSON.parse(await redisClient.call('JSON.GET', locationDetailsKey, ...jsonPath));
    res.status(200).json(locationDetails);
  },
);

// This should also optionally take location type and min star rating request parameters.
router.get(
  '/locations/:latitude/:longitude/:radius',
  [
    param('latitude').isFloat(),
    param('longitude').isFloat(),
    param('radius').isInt({ min: 1 }),
    query('type').isString().optional(),
    query('minStars').isInt({ min: 1, max: 5 }).optional(),
    apiErrorReporter,
  ],
  async (req, res, next) => res.status(200).json({ status: 'TODO' }),
);

// Call an external weather API to get weather for a given location ID.
router.get(
  '/location/:locationId/weather',
  [
    param('locationId').isInt({ min: 1 }),
    apiErrorReporter,
  ],
  async (req, res, next) => {
    const { locationId } = req.params;

    const cachedWeather = await redisClient.get(getWeatherKey(locationId));

    if (cachedWeather) {
      // Cache hit!
      logger.debug(`Cache hit for location ${locationId} weather.`);
      res.status(200).json(JSON.parse(cachedWeather));
    } else {
      // Cache miss :(
      logger.debug(`Cache miss for location ${locationId} weather.`);
      next();
    }
  },
  async (req, res, next) => {
    const { locationId } = req.params;

    // Get the co-ordinates for this location from Redis.
    const locationKey = redis.getKeyName('locations', locationId);

    // Get lng,lat coordinates from Redis.
    const coords = await redisClient.hget(locationKey, 'location');
    const [lng, lat] = coords.split(',');

    // Call the API.
    const apiResponse = await fetch(`https://api.openweathermap.org/data/2.5/weather?units=imperial&lat=${lat}&lon=${lng}&appid=${process.env.WEATHER_API_KEY}`);
    const weatherJSON = await apiResponse.json();

    // Store the results in Redis and set TTL.
    redisClient.setex(getWeatherKey(locationId), CACHE_TIME, JSON.stringify(weatherJSON));

    res.status(200).json(weatherJSON);
  },
);

module.exports = router;
