import { default as Crypto } from "crypto";
import { delay } from './utilities';

const JSON_MIME_TYPE = 'application/json';
const GAME_CLIENT_API_ENDPOINT = '/api/game/client';
const LOGIN_ENDPOINT = `${GAME_CLIENT_API_ENDPOINT}/signin`;
const LOGIN_WITH_CLAIMS_ENDPOINT = `${GAME_CLIENT_API_ENDPOINT}/signinwithclaims`;
const COPY_ACCOUNT_TO_TEST_ENDPOINT = '/api/account/copyaccount';
const REMOVE_ACCOUNT_FROM_TEST_ENDPOINT = '/api/account/erasecopyaccount';


const LOGOUT_ENDPOINT = `${GAME_CLIENT_API_ENDPOINT}/signout`;
const GENERATE_ENDPOINT = `${GAME_CLIENT_API_ENDPOINT}/generateclaims`;
const ACCEPT_AGREEMENT_ENDPOINT = `${GAME_CLIENT_API_ENDPOINT}/loguseragreement`;
const AGREEMENT_ENDPOINT = '/agreement';
const LATEST_NEWS_ENDPOINT = `${GAME_CLIENT_API_ENDPOINT}/getlatestnews`;
const PATCH_NOTES_ENDPOINT = `${GAME_CLIENT_API_ENDPOINT}/getpatchnotes`;

const ERROR_SESSION_MISTMATCH = 'ErrSessionMismatch';

const Environments = {
  PUBLIC: 'Public',
  TEST: 'Test'
};

const _loginInfo = Symbol('Login Info');
const _testLoginInfo = Symbol('Login Info');
const _publicSessionInfo = Symbol('Public Session Info');
const _testSessionInfo = Symbol('Test Session Info');
const _publicUrl = Symbol('public url');
const _testUrl = Symbol('test url');
const _environment = Symbol('environment');

const ConfigurationOptions = {
  MUTED: 'configuration_muted',
  USERNAME: 'configuration_username',
  DOWNLOAD_CAP: 'download_cap'
};

export default class Launcher {

  constructor(publicUrl, testUrl) {
    this[_publicUrl] = publicUrl;
    this[_testUrl] = testUrl;
    this[_environment] = Environments.PUBLIC;
    this[_loginInfo] = null;
    this[_publicSessionInfo] = null;
    this.deleteAllCookies();
  }

  start() {
    window.launcher.start();
    return this;
  }

  minimize() {
    window.launcher.minimize();
    return this;
  }

  show() {
    window.launcher.show();
    return this;
  }

  hide() {
    window.launcher.hide();
    return this;
  }

  quit() {
    window.launcher.hide();
    window.launcher.quit();
    return this;
  }

  setDraggableElement(element) {
    const { left, top, width, height } = element.getBoundingClientRect();
    const { pageXOffset, pageYOffset } = window;
    const { clientLeft, clientTop } = window.document.documentElement;

    window.launcher.setDraggableArea(
      left + pageXOffset - clientLeft,
      top + pageYOffset - clientTop,
      width,
      height
    );

    return this;
  }

  move(x = 0, y = 0) {
    window.launcher.move(x, y);
    return this;
  }

  center() {
    window.launcher.center();
    return this;
  }

  resize(width, height) {
    window.launcher.resize(width, height);
    return this;
  }

  openInBrowser(url) {
    window.launcher.openInBrowser(url);
    return this;
  }

  login(username, password) {
    const md5Hasher = Crypto.createHash('md5');
    md5Hasher.update(password);
    const hashedPassword = md5Hasher.digest('hex');
    const options = {
      method: 'POST',
      headers: {
        'Accept': JSON_MIME_TYPE,
        'Content-Type': JSON_MIME_TYPE
      },
      body: JSON.stringify({ username, password: hashedPassword })
    };

    if (this[_publicSessionInfo]) {
      const { sessionName, sessionToken } = this[_publicSessionInfo];
      
      options.headers[`X-${sessionName}`] = sessionToken;
    }

    return fetch(`${this[_publicUrl]}${LOGIN_ENDPOINT}`, options)
      .then(response => response.json())
      .then(response => {
        if (!!response.success) {
          this[_loginInfo] = response.data;

          const {
            session_name: sessionName,
            session_id: sessionToken
          } = response.data;
          
          this[_publicSessionInfo] = { sessionName, sessionToken };
          return response.data;
        } else {
          if (response.code === ERROR_SESSION_MISTMATCH) {
            return this.deleteAllCookies()
              .then(() => this.login(username, password));
          }
        }
        
        return Promise.reject(response);
      }); 
  }

  _loginTest() {
    const generateClaimOptions = {
      method: 'POST',
      headers: {
        'Accept': JSON_MIME_TYPE,
        'Content-Type': JSON_MIME_TYPE
      }
    };

    if (this[_publicSessionInfo]) {
      const { sessionName, sessionToken } = this[_publicSessionInfo];
      
      generateClaimOptions.headers[`X-${sessionName}`] = sessionToken;
    }

    return fetch(`${this[_publicUrl]}${GENERATE_ENDPOINT}`, generateClaimOptions)
      .then(response => response.json())
      .then(response => {
        if (!!response.success) {
          return response.data;
        }
        
        return Promise.reject(response);
      })
      .then(claims => {
        const signinWithClaimsOptions = {
          method: 'POST',
          headers: {
            'Accept': JSON_MIME_TYPE,
            'Content-Type': JSON_MIME_TYPE
          },
          body: JSON.stringify({ claims })
        };

        if (this[_testSessionInfo]) {
          const { sessionName, sessionToken } = this[_testSessionInfo];
          
          signinWithClaimsOptions.headers[`X-${sessionName}`] = sessionToken;
        }

        return fetch(`${this[_testUrl]}${LOGIN_WITH_CLAIMS_ENDPOINT}`, signinWithClaimsOptions)
          .then(response => response.json())
          .then(response => {
              if (!!response.success) {
                this[_testLoginInfo] = response.data;

                const {
                  session_name: sessionName,
                  session_id: sessionToken
                } = response.data;
                
                this[_testSessionInfo] = { sessionName, sessionToken };

                return response.data;
              } else {
                if (response.code === ERROR_SESSION_MISTMATCH) {
                  return this.deleteAllCookies()
                    .then(() => this._loginTest());
                }
              }
              
              return Promise.reject(response);
          });
      });
  }

  switchToEnvironment(environment) {
    if (environment === Environments.TEST) {
      return this._loginTest()
        .then(response => {
          window.launcher.changeUniverse(Environments.TEST);
          this[_environment] = Environments.TEST;
          return response;
        });
    }

    return this._logoutTest()
      .then(response => {
        window.launcher.changeUniverse(Environments.PUBLIC);
        this[_environment] = Environments.PUBLIC;
        return response;
      });
  }

  getCurrentSessionId() {
    if (this[_environment] === Environments.TEST) {
      return this[_testSessionInfo].sessionToken;
    }

    return this[_publicSessionInfo].sessionToken;
  }

  getCurrentEnvironment() {
    return this[_environment];
  }

  isLoggedIn() {
    return this[_loginInfo] !== null;
  }

  logout() {
    const { sessionName, sessionToken } = this[_publicSessionInfo];

    const options = {
      method: 'POST',
      headers: {
        'Accept': JSON_MIME_TYPE,
        'Content-Type': JSON_MIME_TYPE,
        [`X-${sessionName}`]: sessionToken
      }
    };

    return this._logoutTest()
      .then(() => fetch(`${this[_publicUrl]}${LOGOUT_ENDPOINT}`, options))
      .then(response => response.json())
      .then(response => {
        if (!!response.success) {
          this[_loginInfo] = null;
          return response.data;
        }
        
        return Promise.reject(response);
      }); 
  }

  _logoutTest() {
    if (this[_environment] !== Environments.TEST || !this[_testLoginInfo]) {
      return Promise.resolve();
    }

    const { sessionName, sessionToken } = this[_testSessionInfo];

    const options = {
      method: 'POST',
      headers: {
        'Accept': JSON_MIME_TYPE,
        'Content-Type': JSON_MIME_TYPE,
        [`X-${sessionName}`]: sessionToken
      }
    };

    return fetch(`${this[_testUrl]}${LOGOUT_ENDPOINT}`, options)
      .then(response => response.json())
      .then(response => {
        if (!!response.success) {
          this[_testLoginInfo] = null;
          return response.data;
        }
        
        return Promise.reject(response);
      }); 
  }

  copyAccountToTest() {
    const { sessionName, sessionToken } = this[_publicSessionInfo];

    const options = {
      method: 'POST',
      headers: {
        'Accept': JSON_MIME_TYPE,
        'Content-Type': JSON_MIME_TYPE,
        [`X-${sessionName}`]: sessionToken
      },
      body: JSON.stringify({ destination: 'ptu' })
    };

    return fetch(`${this[_publicUrl]}${COPY_ACCOUNT_TO_TEST_ENDPOINT}`, options)
      .then(response => response.json());
  }

  removeAccountFromTest() {
    const { sessionName, sessionToken } = this[_publicSessionInfo];

    const options = {
      method: 'POST',
      headers: {
        'Accept': JSON_MIME_TYPE,
        'Content-Type': JSON_MIME_TYPE,
        [`X-${sessionName}`]: sessionToken
      },
      body: JSON.stringify({ destination: 'ptu' })
    };

    return fetch(`${this[_publicUrl]}${REMOVE_ACCOUNT_FROM_TEST_ENDPOINT}`, options)
      .then(response => response.json());
  }
  
  latestNews(env) {
    const options = {
      method: 'POST',
      headers: {
        'Accept': JSON_MIME_TYPE,
        'Content-Type': JSON_MIME_TYPE
      }
    };

    let url = this[_publicUrl];
    let sessionInfo = this[_publicSessionInfo];

    if (env === Environments.TEST) {
      url = this[_testUrl];
      sessionInfo = this[_testSessionInfo];
    }

    if (sessionInfo) {
      const { sessionName, sessionToken } = sessionInfo;
      
      options.headers[`X-${sessionName}`] = sessionToken;
    }

    return fetch(`${url}${LATEST_NEWS_ENDPOINT}`, options)
      .then(response => response.json())
      .then(response => {
        if (!!response.success) {
          return response.data.resultset;
        }
        
        return Promise.reject(response);
      }); 
  }

  patchNotes(env) {
    const options = {
      method: 'POST',
      headers: {
        'Accept': JSON_MIME_TYPE,
        'Content-Type': JSON_MIME_TYPE
      }
    };
    
    let url = this[_publicUrl];
    let sessionInfo = this[_publicSessionInfo];
    if (env === Environments.TEST) {
      url = this[_testUrl];
      sessionInfo = this[_testSessionInfo];
    }

    if (sessionInfo) {
      const { sessionName, sessionToken } = sessionInfo;
      
      options.headers[`X-${sessionName}`] = sessionToken;
    }
    
    return fetch(`${url}${PATCH_NOTES_ENDPOINT}`, options)
      .then(response => response.json())
      .then(response => {
        if (!!response.success) {
          return response.data.resultset;
        }
        
        return Promise.reject(response);
      }); 
  }
  
  getAgreementUrl(id, type) {
      return `${AGREEMENT_ENDPOINT}/${type}/${id}`;
  }

  acceptAgreement(id) {
    const { sessionName, sessionToken } = this[_publicSessionInfo];

    const options = {
      method: 'POST',
      headers: {
        'Accept': JSON_MIME_TYPE,
        'Content-Type': JSON_MIME_TYPE,
        [`X-${sessionName}`]: sessionToken
      },
      body: JSON.stringify({ agreement_id: id })
    };

    return fetch(`${this[_publicUrl]}${ACCEPT_AGREEMENT_ENDPOINT}`, options)
      .then(response => response.json())
      .then(response => {
        if (!!response.success) {
          return response.data;
        }
        
        return Promise.reject(response);
      }); 
  }

  getCookie(name) {
    return new Promise(resolve => window.launcher.getCookie(name, resolve));
  }

  deleteCookie(name) {
    return new Promise(resolve => window.launcher.deleteCookie(name, resolve))
      .then(() => delay(100));
  }
  
  deleteAllCookies() {
    return new Promise(resolve => window.launcher.deleteAllCookies(resolve))
      .then(() => delay(100));
  }

  setAuthenticationToken(username, token) {
    return window.launcher.setAuthenticationToken(username, token);
  }

  pauseDownload() {
    return window.launcher.pauseDownload();
  }

  resumeDownload() {
    return window.launcher.resumeDownload();
  }

  setDownloadCap(kbs) {
    return window.launcher.setDownloadCap(kbs);
  }

  addEventListener(event, callback) {
    return window.launcher.addEventListener(event, serializedEvent => callback(JSON.parse(serializedEvent)));
  }

  removeEventListener(event, callback) {
    return window.launcher.removeEventListener(event, callback);
  }

  launchGame() {
    return window.launcher.launchGame();
  }

  checkForGameUpdate() {
    return window.launcher.checkForGameUpdate();
  }

  verify() {
    return window.launcher.verifyDownload();
  }

  getVersion(callback) {
    return window.launcher.getVersion(callback);
  }

  setConfiguration(key, value) {
    window.localStorage.setItem(key, value);
  }

  getConfiguration(key) {
    return window.localStorage.getItem(key);
  }

};

Launcher.ConfigurationOptions = ConfigurationOptions;

