const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const AWS = require('aws-sdk');

process.env.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE = '1';

module.exports = (homebridge) => {
  homebridge.registerPlatform('homebridge-tcl-home', 'TclHome', TclHomePlatform);
};

class TclHomePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];
    this.tclApi = new TclHomeApi(config, this.log);
    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  async discoverDevices() {
    try {
      await this.tclApi.initialize();
      const devices = await this.tclApi.getDevices();
      for (const device of devices) {
        if (device.category === 'AC') this.addAccessory(device);
      }
    } catch (error) { this.log.error('❌ Error discovery:', error.message); }
  }

  addAccessory(device) {
    const uuid = this.api.hap.uuid.generate(device.deviceId);
    const existingAccessory = this.accessories.find(acc => acc.UUID === uuid);
    if (existingAccessory) new TclAirConditioner(this, existingAccessory, device);
    else {
      const accessory = new this.api.platformAccessory(device.deviceName, uuid);
      new TclAirConditioner(this, accessory, device);
      this.api.registerPlatformAccessories('homebridge-tcl-home', 'TclHome', [accessory]);
      this.accessories.push(accessory);
    }
  }

  configureAccessory(accessory) { this.accessories.push(accessory); }
}

class TclHomeApi {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.iotData = null;
    this.lastInit = 0;
  }

  debug(message) { if (this.config.debugMode) this.log.info(`[DEBUG] ${message}`); }

  async initialize() {
    this.debug('🔑 Tokens verversen...');
    try {
      await this.authenticate();
      await this.getCloudUrls();
      await this.refreshTokens();
      await this.getAwsCredentials();
      
      const region = this.cloudUrlsData.data.cloud_region;
      AWS.config.update({ 
          accessKeyId: this.awsCredentials.Credentials.AccessKeyId, 
          secretAccessKey: this.awsCredentials.Credentials.SecretKey, 
          sessionToken: this.awsCredentials.Credentials.SessionToken, 
          region: region 
      });
      this.iotData = new AWS.IotData({ endpoint: `https://data-ats.iot.${region}.amazonaws.com` });
      this.lastInit = Date.now();
      this.debug('✅ Nieuwe sessie gestart');
    } catch (e) {
      this.log.error('❌ Login mislukt:', e.message);
      throw e;
    }
  }

  async ensureAuthenticated() {
    // Proactieve refresh elke 60 minuten (SessionToken is vaak maar 1-2 uur geldig)
    const eenUur = 60 * 60 * 1000;
    if (!this.iotData || (Date.now() - this.lastInit > eenUur)) {
      this.debug('⏰ Proactieve token refresh (60 min limiet)');
      await this.initialize();
    }
  }

  async authenticate() {
    const passwordHash = crypto.createHash('md5').update(this.config.password).digest('hex');
    const response = await axios.post(this.config.appLoginUrl || 'https://pa.account.tcl.com/account/login?clientId=54148614', 
      { equipment: 2, password: passwordHash, osType: 1, username: this.config.username, clientVersion: "4.8.1", channel: "app" });
    this.authData = response.data;
  }

  async getCloudUrls() {
    const response = await axios.post(this.config.cloudUrls || 'https://prod-center.aws.tcljd.com/v3/global/cloud_url_get', 
      { ssoId: this.authData.user.username, ssoToken: this.authData.token });
    this.cloudUrlsData = response.data;
  }

  async refreshTokens() {
    const response = await axios.post(`${this.cloudUrlsData.data.cloud_url}/v3/auth/refresh_tokens`, 
      { userId: this.authData.user.username, ssoToken: this.authData.token, appId: 'wx6e1af3fa84fbe523' });
    this.refreshTokensData = response.data;
  }

  async getAwsCredentials() {
    const decoded = jwt.decode(this.refreshTokensData.data.cognitoToken);
    const response = await axios.post(`https://cognito-identity.${this.cloudUrlsData.data.cloud_region}.amazonaws.com/`, 
      { IdentityId: decoded.sub, Logins: { 'cognito-identity.amazonaws.com': this.refreshTokensData.data.cognitoToken } },
      { headers: { 'X-Amz-Target': 'AWSCognitoIdentityService.GetCredentialsForIdentity', 'content-type': 'application/x-amz-json-1.1' } });
    this.awsCredentials = response.data;
  }

  async getDevices() {
    const timestamp = Date.now().toString();
    const nonce = Math.random().toString(36).substr(2, 16);
    const sign = crypto.createHash('md5').update(timestamp + nonce + this.refreshTokensData.data.saasToken).digest('hex');
    const response = await axios.post(`${this.cloudUrlsData.data.device_url}/v3/user/get_things`, {}, 
      { headers: { 'accesstoken': this.refreshTokensData.data.saasToken, 'timestamp': timestamp, 'nonce': nonce, 'sign': sign } });
    return response.data.data || [];
  }

  async getDeviceState(deviceId) {
    try {
      await this.ensureAuthenticated();
      const result = await this.iotData.getThingShadow({ thingName: deviceId }).promise();
      return JSON.parse(result.payload.toString()).state.reported;
    } catch (error) {
      if (error.statusCode === 403 || error.code === 'ForbiddenException') {
        this.debug('🔄 Forbidden (403) bij status opvragen, sessie herstellen...');
        await this.initialize();
        return this.getDeviceState(deviceId);
      }
      return null;
    }
  }

  async setDeviceState(deviceId, properties) {
    try {
      await this.ensureAuthenticated();
      const payload = { state: { desired: properties }, clientToken: `hb_${Date.now()}` };
      await this.iotData.publish({ topic: `$aws/things/${deviceId}/shadow/update`, payload: JSON.stringify(payload), qos: 1 }).promise();
    } catch (error) {
      if (error.statusCode === 403 || error.code === 'ForbiddenException') {
        this.debug('🔄 Forbidden (403) bij commando, sessie herstellen...');
        await this.initialize();
        await this.setDeviceState(deviceId, properties);
      }
    }
  }
}

class TclAirConditioner {
  constructor(platform, accessory, device) {
    this.platform = platform;
    this.accessory = accessory;
    this.device = device;
    this.lastStateKey = '';
    this.service = this.accessory.getService(this.platform.api.hap.Service.HeaterCooler) ||
                   this.accessory.addService(this.platform.api.hap.Service.HeaterCooler);

    this.setupCharacteristics();
    this.startPolling();
  }

  setupCharacteristics() {
    const Characteristic = this.platform.api.hap.Characteristic;
    this.service.getCharacteristic(Characteristic.Active).onSet(v => this.platform.tclApi.setDeviceState(this.device.deviceId, { powerSwitch: v ? 1 : 0 }));
    this.service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: [1, 2] })
      .onSet(v => this.platform.tclApi.setDeviceState(this.device.deviceId, { powerSwitch: 1, workMode: v === 1 ? 4 : 0 }));
    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({ minValue: 16, maxValue: 30 }).onSet(v => this.setTemp(v));
    this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({ minValue: 18, maxValue: 30 }).onSet(v => this.setTemp(v));
    this.service.getCharacteristic(Characteristic.SwingMode).onSet(v => this.platform.tclApi.setDeviceState(this.device.deviceId, { verticalSwitch: v ? 1 : 0 }));
    this.service.getCharacteristic(Characteristic.RotationSpeed).setProps({ minValue: 0, maxValue: 100, minStep: 1 }).onSet(v => this.setSpeed(v));
  }

  async setSpeed(v) {
    let speed = 0; 
    if (v <= 10) speed = 0;
    else if (v <= 30) speed = 2;
    else if (v <= 50) speed = 3;
    else if (v <= 70) speed = 4;
    else if (v <= 90) speed = 5;
    else speed = 6;
    this.platform.tclApi.debug(`Fan Slider: ${v}% -> TCL Speed ${speed}`);
    await this.platform.tclApi.setDeviceState(this.device.deviceId, { windSpeed: speed });
  }

  async setTemp(v) {
    const t = Math.round(v);
    await this.platform.tclApi.setDeviceState(this.device.deviceId, { targetCelsiusDegree: t, targetTemperature: t });
  }

  updateHomeKit(state) {
    const Characteristic = this.platform.api.hap.Characteristic;
    const isHeat = state.workMode === 4;
    const targetTemp = state.targetTemperature || state.targetCelsiusDegree || 20;
    const stateKey = `${state.powerSwitch}-${state.workMode}-${targetTemp}-${state.windSpeed}-${state.verticalSwitch}`;

    if (this.lastStateKey !== stateKey) {
        this.platform.tclApi.debug(`🔄 Sync: Power=${state.powerSwitch}, Wind=${state.windSpeed}, Temp=${targetTemp}°C`);
        this.lastStateKey = stateKey;
    }

    this.service.updateCharacteristic(Characteristic.Active, state.powerSwitch ? 1 : 0);
    this.service.updateCharacteristic(Characteristic.CurrentHeaterCoolerState, isHeat ? 2 : 3);
    this.service.updateCharacteristic(Characteristic.TargetHeaterCoolerState, isHeat ? 1 : 2);
    this.service.updateCharacteristic(Characteristic.CurrentTemperature, state.currentTemperature || 20);
    if (isHeat) this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, targetTemp);
    else this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, targetTemp);
    this.service.updateCharacteristic(Characteristic.SwingMode, state.verticalSwitch ? 1 : 0);
    const speedMap = { 0: 0, 2: 20, 3: 40, 4: 60, 5: 80, 6: 100 };
    this.service.updateCharacteristic(Characteristic.RotationSpeed, speedMap[state.windSpeed] || 0);
  }

  startPolling() {
    setInterval(async () => {
      const state = await this.platform.tclApi.getDeviceState(this.device.deviceId);
      if (state) this.updateHomeKit(state);
    }, 5000);
  }
}
