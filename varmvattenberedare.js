let CONFIG = {
  NUMBER_OF_EXPENSIVE_HOURS: 8,
  PRICE_REGION: 'SE1',
  UPDATE_INTERVAL: 60 * 1000,
  RELAY_ID: 0,
  NEXT_DAY_FETCH_HOUR: 17,
  WEBHOOK_URL: '',
  MIN_PRICE_THRESHOLD: 0.09
};

let priceControl = {
  today: {},     // Format: {hour: price}
  tomorrow: {},  // Format: {hour: price}
  lastState: null,
  timer: null,

  notify: function(msg) {
    if (!CONFIG.WEBHOOK_URL) return;
    Shelly.call("HTTP.POST", {
      url: CONFIG.WEBHOOK_URL,
      body: JSON.stringify({text: msg}),
      timeout: 15,
      content_type: 'application/json'
    }, null);
  },

  processDay: function(prices, isNextDay) {
    try {
      let blackout = {};
      let hourPrices = [];
      
      // Extract hours and prices
      for (let i = 0; i < prices.length; i++) {
        let p = prices[i];
        let h = parseInt(p.time_start.slice(11,13));
        let price = p.SEK_per_kWh;
        hourPrices[h] = price;
      }
      
      // Store day's prices
      if (isNextDay) {
        this.tomorrow = hourPrices;
      } else {
        this.today = hourPrices;
      }

      // Find expensive hours
      let expensive = [];
      for (let h = 0; h < 24; h++) {
        if (hourPrices[h] >= CONFIG.MIN_PRICE_THRESHOLD) {
          expensive.push({h: h, p: hourPrices[h]});
        }
      }

      // Sort expensive hours
      for (let i = 0; i < expensive.length; i++) {
        for (let j = i + 1; j < expensive.length; j++) {
          if (expensive[j].p > expensive[i].p) {
            let t = expensive[i];
            expensive[i] = expensive[j];
            expensive[j] = t;
          }
        }
      }

      // Select blackout hours
      let count = 0;
      for (let i = 0; count < CONFIG.NUMBER_OF_EXPENSIVE_HOURS && i < expensive.length; i++) {
        let hour = expensive[i].h;
        
        // Check constraints
        let valid = true;
        if (hour >= 7 && hour < 23) {
          // Daytime - no consecutive hours
          if (blackout[hour-1] || blackout[hour+1]) {
            valid = false;
          }
        } else {
          // Nighttime - max 5 consecutive
          let consec = 1;
          let h = hour;
          while (blackout[h-1] && h > 0) {
            consec++;
            if (consec > 5) {
              valid = false;
              break;
            }
            h--;
          }
          if (valid) {
            h = hour;
            while (blackout[h+1] && h < 7) {
              consec++;
              if (consec > 5) {
                valid = false;
                break;
              }
              h++;
            }
          }
        }
        
        if (valid) {
          blackout[hour] = expensive[i].p;
          count++;
        }
      }

      // Generate status with reasons
      let msg = (isNextDay ? 'Tomorrow' : 'Today') + ' power schedule:\n';
      
      for (let h = 0; h < 24; h++) {
        let price = hourPrices[h];
        let isOff = blackout[h];
        let reason = '';
        
        if (price < CONFIG.MIN_PRICE_THRESHOLD) {
          reason = '[Below price threshold]';
        } else if (isOff) {
          reason = '[Peak price hour]';
        } else if (h >= 7 && h < 23) {
          reason = blackout[h-1] || blackout[h+1] ? 
                  '[Max 1h off during day]' : 
                  '[Cheaper than peaks]';
        } else {
          let consec = 1;
          let ch = h;
          while (blackout[ch-1] && ch > 0) {
            consec++;
            ch--;
          }
          reason = consec >= 5 ? 
                   '[Max 5h off at night]' : 
                   '[Cheaper than peaks]';
        }
        
        msg += padNumber(h) + ':00 ' + 
               (isOff ? 'HOFF' : 'ON ') + ' ' +
               price.toFixed(2) + ' SEK/kWh ' + 
               reason + '\n';
      }
      
      this.notify(msg);
      
      // Store result
      if (isNextDay) {
        this.tomorrow = blackout;
      } else {
        this.today = blackout;
      }

    } catch(e) {
      print('Error:', e.message);
    }
  },

  checkRelay: function() {
    let h = new Date().getHours();
    let isOff = this.today[h];
    
    if (!isOff && h < 4 && this.tomorrow) {
      isOff = this.tomorrow[h];
    }

    if (this.lastState !== isOff) {
      this.notify(padNumber(h) + ':00 - ' + (isOff ? 'Heater OFF' : 'Heater ON'));
      this.lastState = isOff;
    }

    Shelly.call("Switch.Set", {
      id: CONFIG.RELAY_ID,
      on: !isOff
    }, null);
  },

  schedule: function() {
    if (this.timer) Timer.clear(this.timer);
    
    let now = new Date();
    
    // Get today's prices
    let url = 'https://www.elprisetjustnu.se/api/v1/prices/' + 
              now.getFullYear() + '/' +
              padNumber(now.getMonth() + 1) + '-' +
              padNumber(now.getDate()) + '_' +
              CONFIG.PRICE_REGION + '.json';
              
    Shelly.call("HTTP.GET", 
      {url: url, timeout: 30},
      function(r, err_code, err_msg) {
        if (err_code === 0 && r && r.body) {
          try {
            this.processDay(JSON.parse(r.body), false);
          } catch(e) {
            print('Parse error:', e.message);
          }
        }
      }.bind(this)
    );
    
    // Get tomorrow's prices if after fetch hour
    if (now.getHours() >= CONFIG.NEXT_DAY_FETCH_HOUR) {
      let tomorrow = new Date(now.getTime() + 24*60*60*1000);
      let url = 'https://www.elprisetjustnu.se/api/v1/prices/' + 
                tomorrow.getFullYear() + '/' +
                padNumber(tomorrow.getMonth() + 1) + '-' +
                padNumber(tomorrow.getDate()) + '_' +
                CONFIG.PRICE_REGION + '.json';
                
      Shelly.call("HTTP.GET", 
        {url: url, timeout: 30},
        function(r, err_code, err_msg) {
          if (err_code === 0 && r && r.body) {
            try {
              this.processDay(JSON.parse(r.body), true);
            } catch(e) {
              print('Parse error:', e.message);
            }
          }
        }.bind(this)
      );
    }
    
    // Set timer for periodic checks
    this.timer = Timer.set(60*1000, true, function() {
      this.checkRelay();
      if (new Date().getMinutes() === 0) {
        this.schedule();
      }
    }.bind(this));
  }
};

function padNumber(n) {
  return n < 10 ? '0' + n : n;
}

priceControl.schedule();
