function padNumber(num) {
  if (num < 10) {
    return '0' + num;
  }
  return '' + num;
}

let CONFIG = {
  NUMBER_OF_EXPENSIVE_HOURS: 8,
  PRICE_REGION: 'SE1',
  UPDATE_INTERVAL: 60 * 1000,
  RELAY_ID: 0,
  NEXT_DAY_FETCH_HOUR: 17,
  WEBHOOK_URL: '',
  MIN_PRICE_THRESHOLD: 0.09,
  LATITUDE: '64.6857',
  LONGITUDE: '20.6049',
  TEMP_CHECK_INTERVAL: 30 * 60 * 1000, // 30 minuter
  TEMP_THRESHOLD: 1.0, // Aktivera värmekabel vid denna temp eller lägre
  TEMP_HYSTERESIS: 0.5 // Extra marginal för att undvika snabba växlingar
};


let priceControl = {
  activePeriods: null,
  nextDayPeriods: null,
  lastRelayState: null,
  temperatureForecast: {},
  updateTimer: null,
  scheduleTimer: null,
  nextDayTimer: null,
  tempCheckTimer: null,
  
  notifySlack: function(msg) {
    if (!CONFIG.WEBHOOK_URL) {
      return;
    }
    
    Shelly.call(
      "HTTP.POST",
      {
        url: CONFIG.WEBHOOK_URL,
        body: JSON.stringify({ text: msg }),
        timeout: 15,
        content_type: 'application/json'
      },
      null
    );
  },

  checkTemperature: function() {
    var self = this;
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + 
              CONFIG.LATITUDE + '&longitude=' + CONFIG.LONGITUDE + 
              '&hourly=temperature_2m&forecast_hours=12';
    
    print('Hamtar temperaturdata...');
    
    Shelly.call(
      "HTTP.GET",
      { url: url, timeout: 30 },
      function(response, error_code, error_message) {
        if (error_code !== 0) {
          print('Fel vid temperaturhamtning: ' + error_message);
          return;
        }
        
        try {
          var weather = JSON.parse(response.body);
          self.temperatureForecast = {};
          
          print('Temperaturer:');
          var i;
          for (i = 0; i < weather.hourly.time.length; i++) {
            var timeStr = weather.hourly.time[i];
            var hour = parseInt(timeStr.substr(11, 2));
            var temp = weather.hourly.temperature_2m[i];
            self.temperatureForecast[hour] = temp;
            print(hour + ':00 - ' + temp + ' C');
          }
          
          if (self.activePeriods) {
            self.updatePlanning();
          }
        } catch (e) {
          print('Fel vid parsning: ' + e);
        }
      }
    );
  },

  updatePlanning: function() {
    var message = 'Planering:';
    print(message);
    
    var now = new Date();
    var currentHour = now.getHours();
    var temp = this.temperatureForecast[currentHour];
    
    if (temp === undefined) {
      print('Ingen temperatur for timme ' + currentHour);
      return;
    }
    
    var status = this.shouldHeatBeOn(currentHour, temp);
    print(currentHour + ':00 - ' + temp + 'C - Varme: ' + (status ? 'PA' : 'AV'));
  },

  shouldHeatBeOn: function(hour, temp) {
    if (temp > CONFIG.TEMP_THRESHOLD) {
      return false;
    }
    
    if (temp > -CONFIG.TEMP_HYSTERESIS) {
      return true;
    }
    
    if (this.activePeriods && this.activePeriods[hour]) {
      return false;
    }
    
    return true;
  },

  processPrices: function(prices, isNextDay) {
    try {
      var blackoutHours = {};
      var count = 0;
      var priceData = [];
      var i, j;
      
      // Skapa prislista
      for (i = 0; i < prices.length; i++) {
        var hour = parseInt(prices[i].time_start.substr(11, 2));
        priceData[i] = {
          hour: hour,
          price: prices[i].SEK_per_kWh
        };
      }
      
      // Bubbelsort pa pris
      for (i = 0; i < priceData.length; i++) {
        for (j = 0; j < priceData.length - i - 1; j++) {
          if (priceData[j].price < priceData[j + 1].price) {
            var temp = priceData[j];
            priceData[j] = priceData[j + 1];
            priceData[j + 1] = temp;
          }
        }
      }
      
      // Valj timmar
      for (i = 0; i < priceData.length && count < CONFIG.NUMBER_OF_EXPENSIVE_HOURS; i++) {
        var data = priceData[i];
        
        if (data.price < CONFIG.MIN_PRICE_THRESHOLD) {
          continue;
        }
        
        var prevHour = (data.hour - 1 + 24) % 24;
        var nextHour = (data.hour + 1) % 24;
        
        if (blackoutHours[prevHour] || blackoutHours[nextHour]) {
          continue;
        }
        
        blackoutHours[data.hour] = data.price;
        count = count + 1;
      }
      
      if (isNextDay) {
        this.nextDayPeriods = blackoutHours;
      } else {
        this.activePeriods = blackoutHours;
        this.updatePlanning();
      }
      
    } catch (e) {
      print('Error i processPrices: ' + e);
    }
  },

  checkAndSetRelay: function() {
    var now = new Date();
    var hour = now.getHours();
    var currentTemp = this.temperatureForecast[hour];
    
    if (currentTemp === undefined) {
      this.checkTemperature();
      return;
    }
    
    var shouldBeOn = this.shouldHeatBeOn(hour, currentTemp);
    
    if (this.lastRelayState !== shouldBeOn) {
      var timeStr = padNumber(hour) + ':' + padNumber(now.getMinutes());
      var msg = timeStr + ' - Varmekabel ' + (shouldBeOn ? 'PA' : 'AV') + 
                ' (' + currentTemp + ' C)';
      print(msg);
      this.notifySlack(msg);
      this.lastRelayState = shouldBeOn;
    }

    Shelly.call("Switch.Set", { id: CONFIG.RELAY_ID, on: shouldBeOn }, null);
  },

  fetchPrices: function(date, isNextDay) {
    var self = this;
    var year = date.getFullYear();
    var month = padNumber(date.getMonth() + 1);
    var day = padNumber(date.getDate());
    var formattedDate = year + '/' + month + '-' + day;
    var url = 'https://www.elprisetjustnu.se/api/v1/prices/' + 
              formattedDate + '_' + CONFIG.PRICE_REGION + '.json';
    
    Shelly.call(
      "HTTP.GET",
      { url: url, timeout: 30 },
      function(response, error_code, error_message) {
        if (error_code !== 0) {
          print('Fel vid prishamtning: ' + error_message);
          return;
        }
        try {
          var prices = JSON.parse(response.body);
          self.processPrices(prices, isNextDay);
        } catch (e) {
          print('Fel vid prisparsning: ' + e);
        }
      }
    );
  },

  schedule: function() {
    var self = this;
    
    if (this.updateTimer) Timer.clear(this.updateTimer);
    if (this.scheduleTimer) Timer.clear(this.scheduleTimer);
    if (this.nextDayTimer) Timer.clear(this.nextDayTimer);
    if (this.tempCheckTimer) Timer.clear(this.tempCheckTimer);
    
    print('Startar schema...');
    
    // Initial check
    this.checkTemperature();
    
    // Temperaturtimer
    this.tempCheckTimer = Timer.set(CONFIG.TEMP_CHECK_INTERVAL, true, function() {
      self.checkTemperature();
    });
    
    // Hämta dagens priser
    var now = new Date();
    this.fetchPrices(now, false);
    
    // Morgondagens priser
    if (now.getHours() >= CONFIG.NEXT_DAY_FETCH_HOUR) {
      var tomorrow = new Date(now.getTime() + 86400000);
      this.nextDayTimer = Timer.set(5000, false, function() {
        self.fetchPrices(tomorrow, true);
      });
    }
    
    // Kontrollera relay status
    this.updateTimer = Timer.set(CONFIG.UPDATE_INTERVAL, true, function() {
      self.checkAndSetRelay();
    });
    
    // Timvis uppdatering
    this.scheduleTimer = Timer.set(3600000, true, function() {
      self.schedule();
    });
  }
};

// Starta
priceControl.schedule();
