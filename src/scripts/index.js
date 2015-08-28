import 'babel/polyfill';
import jQuery from 'jquery';
import Launcher from './launcher';
import SoundManager from './sound-manager';
import { delay } from './utilities';
import 'fetch';
import XSelectElement from './lib/x-select';


const PUBLIC_API_HOST = 'https://robertsspaceindustries.com';
const TEST_API_HOST = 'https://ptu.cloudimperiumgames.com';
const AGREEMENT_ACCEPT = 'accept';
const AGREEMENT_CANCEL = 'cancel';

const launcher = new Launcher(PUBLIC_API_HOST, TEST_API_HOST);
const soundManager = new SoundManager(.5);

soundManager
  .load('open', 'audio/phazein.wav')
  .load('login', 'audio/website_ui_savesettings.wav')
  .load('error', 'audio/website_ui_rejection.wav')
  .load('music', 'audio/music_launcher.ogg');

const showLoginError = (errorMessage) => {
  const errorNode = jQuery('#login .error');

  errorNode.empty().html(errorMessage);
  errorNode.css('opacity', 1);
};

const hideLoginError = () => {
  const errorNode = jQuery('#login .error');

  errorNode.css('opacity', 0);
  setTimeout(() => errorNode.empty(), 125);
};


const showFatalError = (errorMessage, title="Fatal Error") => {
  const errorNode = jQuery('#fatal-error'),
        titleNode = errorNode.find('h1'),
        messageNode = errorNode.find('p');

  titleNode.empty().html(title);
  messageNode.empty().html(errorMessage);
  $('#launcher').addClass('modal');
  errorNode.show();
  errorNode.css('opacity', 1);
};

const hideFatalError = () => {
  const errorNode = jQuery('#fatal-error'),
        titleNode = errorNode.find('h1'),
        messageNode = errorNode.find('p');

  $('#launcher').removeClass('modal');
  errorNode.hide();
  errorNode.css('opacity', 0);
  setTimeout(() => { messageNode.empty(); titleNode.empty() }, 125);
};

jQuery(document).on('click', '.close-fatal-error', function() {
  hideFatalError();
});


const hideInfoBox = () => {
  const infoBoxNode = jQuery('#info-box-modal'),
        titleNode = infoBoxNode.find('h1'),
        messageNode = infoBoxNode.find('p');

  $('#launcher').removeClass('modal');
  infoBoxNode.hide();
  infoBoxNode.css('opacity', 0);
  setTimeout(() => { messageNode.empty(); titleNode.empty() }, 125);
};

const showInfoBox = (title, message, buttons) => {
  const infoBoxNode = jQuery('#info-box-modal'),
        titleNode = infoBoxNode.find('h1'),
        messageNode = infoBoxNode.find('p'),
        infoBoxOptions = infoBoxNode.find('.info-box-options'),
        infoBoxButtons = infoBoxOptions.find('a');

  return new Promise(function(resolve, reject) {
    infoBoxButtons.each(function() {
      var button = $(this);

      if (buttons.indexOf(button.attr('data-type')) !== -1) {
        button.show()
      } else {
        button.hide();
      }
    });

    infoBoxOptions.one('click', 'a', function() {
      var type = $(this).attr('data-type');

      event.preventDefault();
      hideInfoBox();
      resolve(type);
    });

    titleNode.empty().html(title);
    messageNode.empty().html(message);
    $('#launcher').addClass('modal');
    infoBoxNode.show();
    infoBoxNode.css('opacity', 1);
  });
};

jQuery(document).on('click', '.close-info-box', function() {
  hideInfoBox();
});

const promisifiedIframe = (url, targetNode) => {
  return new Promise((resolve, reject) => {
    var iframe = jQuery('<iframe></iframe>');

    iframe.on('load', () => resolve(iframe[0]));
    iframe.on('error', reject);
    iframe.prop('src', url);
    jQuery(targetNode).empty().append(iframe);
  });
};

const showUserAgreement = (id, type) => {
  const agreementUrl = `${PUBLIC_API_HOST}${launcher.getAgreementUrl(id, type)}`;
  const agreement = jQuery('#agreement');
  const agreementForm = agreement.find('form');
  const launcherNode = jQuery('#launcher');

  return promisifiedIframe(agreementUrl, agreement.find('.wrapper')[0])
    .then(iframe => {
      launcherNode.addClass('modal');
      return delay(125);
    })
    .then(() => {
      return new Promise((resolve, reject) => {
        agreementForm.one('submit', (event) => {
          event.preventDefault();
          const result = agreementForm.data('value');

          agreementForm.data('value', null);
          agreement.removeClass('display');
          launcherNode.removeClass('modal');

          if (result === AGREEMENT_ACCEPT) {
            resolve(result);
          } else {
            reject(result);
          }
        });

        agreement.addClass('display');
      });
    })
    .then(() => launcher.acceptAgreement(id));
};

const showUserAgreements = ([agreement, ...others]) => {
  if (!agreement) {
    return Promise.resolve([]);
  }

  const { type, id } = agreement;

  return showUserAgreement(id, type)
    .then(() => showUserAgreements(others));
};

const formatBytes = (bytes) => {
  const KILOBYTE = 1024;
  const MEGABYTE = KILOBYTE * 1024;
  const GIGABYTE = MEGABYTE * 1024;
  let result = '';

  const gigabytes = Math.floor(bytes / GIGABYTE);
  const megabytes = Math.floor((bytes % GIGABYTE) / MEGABYTE);
  const kilobytes = Math.floor((bytes % GIGABYTE % MEGABYTE) / KILOBYTE);
  const leftBytes = Math.floor((bytes % GIGABYTE % MEGABYTE % KILOBYTE));

  if (gigabytes > 0) {
    const hundredsOfGigabyte = Math.floor(megabytes / 100);
    return `${gigabytes}.${hundredsOfGigabyte}GB`;
  } else if (megabytes > 0) {
    const hundredsOfMegabyte = Math.floor(kilobytes / 100);
    return `${megabytes}.${hundredsOfMegabyte}MB`;
  } else {
    const tenthsOfKilobyte = Math.floor(leftBytes / 10);
    return `${kilobytes}.${tenthsOfKilobyte}KB`;
  }
};

const updateDownloadProgress = (status, total, loaded, uploadRate, downloadRate, peers, progress) => {
  const gameCommandsNode = $('#news-and-launch .game-commands');
  const downloadProgressNode = gameCommandsNode.find('.download-progress');
  const progressNode = downloadProgressNode.find('progress');
  const estimatedTimeNode = downloadProgressNode.find('.estimated-time');
  const bytesLeftNode = downloadProgressNode.find('.bytes-left');
  const downloadRateNode = downloadProgressNode.find('.download-speed');
  const uploadRateNode = downloadProgressNode.find('.upload-speed');
  const peersNode = downloadProgressNode.find('.peers');
  const launcherOptionsNode = gameCommandsNode.find('.launch-options');

  if (status === "Downloading" || status == "Verifying") {
    const timeLeft = (total - loaded) / downloadRate;
    let formatedTimeLeft;

    downloadProgressNode.addClass('downloading');
    downloadProgressNode.prop('hidden', false);
    launcherOptionsNode.prop('hidden', true);

    if (isFinite(timeLeft)) {
      if (timeLeft < 60) {
        formatedTimeLeft = '<1m';
      } else if (timeLeft < (60 * 60)) {
        formatedTimeLeft = Math.floor(timeLeft / 60) + "m";
      } else if (timeLeft < (60 * 60 * 24)){
        const hours = Math.floor(timeLeft / (60 * 60));
        const minutes = Math.floor((timeLeft % (60 * 60)) / 60);
        formatedTimeLeft = `${hours}h${minutes}m`;
      } else {
        const days = Math.floor(timeLeft / (60 * 60 * 24));
        const hours = Math.floor((timeLeft / (60 * 60 * 24)) % (60 * 60));
        const minutes = Math.floor((timeLeft % (60 * 60)) / 60);
        formatedTimeLeft = `${days}d${hours}h${minutes}m`;
      }
    } else {
      formatedTimeLeft = '--';
    }

    requestAnimationFrame(() => {
      progressNode.val(((loaded / total * 100)).toFixed(3));
      estimatedTimeNode.html(formatedTimeLeft);
      if (status == "Verifying") {
        bytesLeftNode.html("Estimating...");
      } else {
        bytesLeftNode.html(formatBytes(total - loaded));
      }
      downloadRateNode.html(formatBytes(downloadRate) + '/s');
      //uploadRateNode.html(formatBytes(uploadRate) + '/s');
      //peersNode.html(peers);
    });
  } else if (status === "Checking Download") {
    downloadProgressNode.removeClass('downloading');
    downloadProgressNode.prop('hidden', false);
    launcherOptionsNode.prop('hidden', true);
    requestAnimationFrame(() => {
      progressNode.val('--');
      estimatedTimeNode.html('--');
      bytesLeftNode.html('--');
      downloadRateNode.html('--');
      //uploadRateNode.html('--');
      //peersNode.html('--');
    });
  } else {
    requestAnimationFrame(() => {
      progressNode.val(0);
      estimatedTimeNode.html('');
      bytesLeftNode.html('');
      downloadRateNode.html('');
      //uploadRateNode.html('');
      //peersNode.html('');
    });
  }
};

const resetDownloadProgress = () => {
  const gameCommandsNode = $('#news-and-launch .game-commands');
  const downloadProgressNode = gameCommandsNode.find('.download-progress');
  const progressNode = downloadProgressNode.find('progress');
  const estimatedTimeNode = downloadProgressNode.find('.estimated-time');
  const bytesLeftNode = downloadProgressNode.find('.bytes-left');
  const downloadRateNode = downloadProgressNode.find('.download-speed');
  const uploadRateNode = downloadProgressNode.find('.upload-speed');
  const peersNode = downloadProgressNode.find('.peers');
  const launcherOptionsNode = gameCommandsNode.find('.launch-options');

  requestAnimationFrame(() => {
    progressNode.val(0);
    estimatedTimeNode.html('--');
    bytesLeftNode.html('--');
    downloadRateNode.html('--');
    //uploadRateNode.html('--');
    //peersNode.html('--');
  });
};

const updatePatcherStatus = (status) => {
  const gameCommandsNode = $('#news-and-launch .game-commands');
  const downloadStatusNode = gameCommandsNode.find('h1');

  let statusToDisplay = "Unknown";

  if (status === "Downloading" || status === "Checking Download") {
    statusToDisplay = "Updating";
  } else if (status === "Ready") {
    statusToDisplay = "Ready to launch";
    const launcherOptionsNode = gameCommandsNode.find('.launch-options');
    const downloadProgressNode = gameCommandsNode.find('.download-progress');
    downloadProgressNode.removeClass('downloading');
    downloadProgressNode.prop('hidden', true);
    launcherOptionsNode.prop('hidden', false);
  } else if (status === "Pause") {
    statusToDisplay = "Paused";
    resetDownloadProgress();
  }

  downloadStatusNode.text(statusToDisplay);
};

const getNewsAndPatchNotes = (env) => Promise.all([launcher.latestNews(env), launcher.patchNotes(env)])
    .then(([news, [notes] = []]) => {
      const newsTemplate = $('#comm-link-template').html();
      const newTemplates = news.map(({title, url, publish_start, excerpt}) => {
        return newsTemplate.replace("{title}", title || "Unknown")
                           .replace("{url}", url || "#")
                           .replace("{time}", publish_start || "Unknown")
                           .replace("{summary}", excerpt || "Unknown");
      });

      let time = 'Unknown';
      if (notes.publish_start) {
        const publishStart = new Date(notes.publish_start);
        time = [publishStart.getMonth() + 1, publishStart.getDate(), publishStart.getFullYear()].join(' / ');
      }
      const patchNotesTemplate = $('#patch-notes-template').html()
                                                           .replace("{title}", notes.title || "Unknown")
                                                           .replace("{url}", notes.url || "#")
                                                           .replace("{time}", time)
                                                           .replace("{notes}", notes.body || "Unknown");

      $('#comm-links ul').html($.parseHTML(`<li>${newTemplates.join('</li><li>')}</li>`));
      $('#patch-notes').html($.parseHTML(patchNotesTemplate));
    });

jQuery(function($) {

  launcher.resize(1100, 545)
          .center()
          .show();

  delay(750).then(() => launcher.setDraggableElement($('[data-draggable-area]')[0]));

  const isMuted = launcher.getConfiguration(Launcher.ConfigurationOptions.MUTED) === '1';

  if (isMuted) {
    soundManager.mute();
    $('.mute').addClass('muted');
  }

  $('.copyright .year').text((new Date()).getFullYear());

  launcher.getVersion(function(version) {
    $('.launcher-version .number').text(version); 
  });

  new XSelectElement($('.settings-download-limit')[0]);

  $('.access-circles').animate({ opacity: 1 }, 1000);
    $('#login').animate({ opacity: 1 }, 1000)
      .promise()
      .done(function() {
        soundManager.getSound('open')
          .then(sound => sound.play());
          
        const usernameField = $('#login-username');
        const passwordField = $('#login-password');
        const username = launcher.getConfiguration(Launcher.ConfigurationOptions.USERNAME) || '';

        if (username.length > 0) {
          usernameField.val(username);
          setTimeout(function() { passwordField.focus(); }, 25);
        } else {
          usernameField.focus();
        }
  });

  launcher.addEventListener('error', function(event) {
    showFatalError(event.error, event.type);
  });

  launcher.addEventListener("download-progress", function(event) {
    updateDownloadProgress(event.state, event.totalSize, event.downloadedSoFar, event.uploadRate, event.downloadRate, event.peers, event.progress);
  });

  launcher.addEventListener('download-start', function(event) {
    console.log('Download starting', event);
    if (event && event.version) {
      $('.game-version span').text(event.version);
    }
  });

  launcher.addEventListener('game-update-available', function(event) {
    console.log('Update Available', event);
    if (event && event.version) {
      $('.game-version span').text(event.version);
    }
    launcher.resumeDownload();
  });

  launcher.addEventListener('patcher-state-change', function(event) {
    console.log('Patcher State Change', event);
    if (event && event.state === "Ready" && event.version) {
      $('.game-version span').text(event.version);
    }
    updatePatcherStatus(event.state);
  });

  $(document.body).on('click', '.mute', function(event) {
    const element = $(this);

    event.preventDefault();

    if (element.hasClass('muted')) {
      soundManager.unmute();
      launcher.setConfiguration(Launcher.ConfigurationOptions.MUTED, 0);
      element.removeClass('muted');
    } else {
      soundManager.mute();
      launcher.setConfiguration(Launcher.ConfigurationOptions.MUTED, 1);
      element.addClass('muted');
    }
  });

  $(document.body).on('click', '[data-command-minimize]', function(event) {
    event.preventDefault();
    launcher.minimize();
  });

  $(document.body).on('click', '[data-command-quit]', function(event) {
    event.preventDefault();
    launcher.quit();
  });

  $(document.body).on('click', 'a[data-external]', function(event) {
    event.preventDefault();
    launcher.openInBrowser(this.href);
  });

  $(document.body).on('click', '.settings-container .settings', function(event) {
    event.preventDefault();

    $('.settings-container').toggleClass('open');
  })

  $(document.body).on('click', '.settings-copy-account', function(event) {
    event.preventDefault();
    $('.settings-container').removeClass('open');
    showInfoBox('Copy to PTU', 'Are you sure you want to copy your LIVE account to the PTU? If a PTU account already exists, it will be overwritten.', ['YES', 'NO'])
      .then(function(answer) {
        if (answer === 'YES') {
          return launcher.copyAccountToTest()
        }

        return Promise.resolve();
      });
  });

  $(document.body).on('click', '.settings-remove-account', function(event) {
    event.preventDefault();
    $('.settings-container').removeClass('open');
    showInfoBox('Remove account from PTU', 'Are you sure you want to remove your PTU account?', ['YES', 'NO'])
      .then(function(answer) {
        if (answer === 'YES') {
          return launcher.removeAccountFromTest()
        }

        return Promise.resolve();
      });
  });

  $(document.body).on('click', '.settings-verify', function(event) {
    event.preventDefault();
    launcher.verify();
    $('.settings-container').removeClass('open');
  });

  var environmentSwitcher = $('#environment-switcher');
  environmentSwitcher.on('change', '[type="radio"]', function(event) {
    var environment = this.value;

    if (environment === 'Test') {
      environmentSwitcher.addClass('mode-test').removeClass('mode-public');
      delay(125)
        .then(function() {
          environmentSwitcher.addClass('loading');
          return launcher.switchToEnvironment(environment);
        })
        .then(() => {
          $('body').addClass('ptu');
          getNewsAndPatchNotes(environment);
          launcher.setAuthenticationToken(launcher.getConfiguration(Launcher.ConfigurationOptions.USERNAME), launcher.getCurrentSessionId());
          environmentSwitcher.removeClass('loading');
        })
        .catch(function(error) {
          environmentSwitcher.removeClass('mode-test loading').addClass('mode-public');
          $('#environment-public').prop('checked', true);
          if (error.code && error.code === 'HeapUnrecognizedAccountException') {
            showInfoBox('Warning', 'You need to copy your LIVE account to the PTU before you can use it', ['OK']);
          }
          console.log(error);
        });
    } else {
      environmentSwitcher.removeClass('mode-test').addClass('mode-public loading');
      launcher.switchToEnvironment(environment)
        .then(() => {
          $('body').removeClass('ptu');
          getNewsAndPatchNotes(environment);
          launcher.setAuthenticationToken(launcher.getConfiguration(Launcher.ConfigurationOptions.USERNAME), launcher.getCurrentSessionId());
          environmentSwitcher.removeClass('loading');
        });
    }
  });

  $(document.body).on('click', function(event) {
    var settingsContainer = $('.settings-container');

    if ($(event.target).closest('.settings-container').length === 0) {
      if (settingsContainer.hasClass('open')) {
        settingsContainer.removeClass('open');
      }
    }
  });

  $(document.body).on('submit', '.settings-dropdown', function(event) {
    var form = $(this);

    event.preventDefault();

    launcher.setDownloadCap(parseInt(form.find('.settings-download-limit').val(), 10));
    $('.settings-container').removeClass('open');
  });

  $('#login').on('click', '.error a', function(event) {
    event.preventDefault();
    launcher.openInBrowser(this.href);
  });

  $(document.body).on('click', '#launch-game', function(event) {
    event.preventDefault();
    $('.mute').addClass('muted');
    soundManager.mute();
    launcher.launchGame();
  });

  $(document.body).on('click', '.pause', function(event) {
    const element = $(this);

    event.preventDefault();

    if (element.hasClass('paused')) {
      launcher.resumeDownload();
      element.removeClass('paused');
    } else {
      launcher.pauseDownload();
      element.addClass('paused');
    }
  });

  const loginFields = $('#login-username, #login-password');

  loginFields.on('focusin focusout', function(event) {
    var element = $(this),
        closestListItem = element.closest('.username, .password');

    if (event.type === 'focusin') {
      closestListItem.addClass('js-highlight');
    } else {
      if (!element.val().length) {
        closestListItem.removeClass('js-highlight');
      }
    }
  });

  $('#login').on('submit', 'form', function(event) {
    const username = $('#login-username');
    const password = $('#login-password');
    const loginNode = $('#login');
    const stripsNode = $('#background-strips');
    const loginOverlayNode = $('#login-overlay');

    event.preventDefault();

    hideLoginError();
    loginNode.addClass('sending');
    recordstrips.activate();
    launcher.login(username.val(), password.val())
      .then(({ agreements, session_id, envs }) => {
        launcher.start();
        launcher.setConfiguration(Launcher.ConfigurationOptions.USERNAME, username.val());

        soundManager.getSound('login')
          .then(sound => sound.play());
        setTimeout(() => {
          soundManager.getSound('music')
            .then(sound => sound.play({ loop: true }));
        }, 1000);
        launcher.setAuthenticationToken(username.val(), session_id);
        loginNode.removeClass('sending');
        recordstrips.deactivate();
        password.val('');
        return Promise.resolve(loginNode.fadeOut('slow').promise())
          .then(() => {
            const downloadCap = launcher.getConfiguration(Launcher.ConfigurationOptions.DOWNLOAD_CAP);

            if (downloadCap) {
              launcher.setDownloadCap(parseInt(downloadCap, 10));
            }

            loginOverlayNode.addClass('logged-in');
            return delay(2500);
          })
          .then(() => {
            return showUserAgreements(agreements);
          })
          .then(() => {
            $('#login').prop('hidden', true);

            $('.settings-container').fadeIn('fast');

            if ('ptu' in envs) {
              $('#environment-switcher').fadeIn('slow');
              $('.settings-ptu .ptu-version .number').text(envs.ptu.version_str);
              $('.settings-dropdown .settings-ptu').show();
            }

            $('#news-and-launch').prop('hidden', false);
          })
          .catch(error => {
            if (error === AGREEMENT_CANCEL) {
              launcher.logout();
              loginOverlayNode.removeClass('logged-in');
              return Promise.resolve(loginNode.fadeIn('slow').promise());
            }

            throw error;
          });
      })
      .catch(error => {
        console.log(error);
        soundManager.getSound('error')
          .then(sound => sound.play());
        const { code, msg } = error;
        recordstrips.deactivate();
        loginNode.removeClass('sending');
        loginOverlayNode.removeClass('logged-in');
        showLoginError(msg ? msg : "An unknown error occurred");
        return true;
      });
  });

  $('#agreement .actions form button').on('click', (event) => {
    const form = $('#agreement .actions form');

    form.data('value', $(event.currentTarget).data('value'));
  });

  $('#login-username').focus();

  getNewsAndPatchNotes('Public');

  const newsAndPatchNotes = $('.news-and-patch-notes');

  newsAndPatchNotes.on('click', 'header a', function(event) {
    const element = $(this);
    const sectionClass = element.attr('href');

    event.preventDefault();

    if (!element.hasClass('active')) {
      element.closest('ul').find('a.active').removeClass('active');
      element.addClass('active');

      newsAndPatchNotes.find('> .content > section').hide();
      $(sectionClass).show();
    }
  });

  const recordstrips = {
    elem: $('#background-strips'),

    children: [
      $('#background-strips .strip:nth-child(1)'),
      $('#background-strips .strip:nth-child(2)'),
      $('#background-strips .strip:nth-child(3)')
    ],

    currStrip: 2,

    getNextStrip: function() {
      if ( ++this.currStrip > 2 )
        this.currStrip = 0;
      return this.currStrip;
    },

    activate: function() {
      this.timer = setInterval($.proxy(this.move, this), 200);
      this.elem.fadeIn(700);
    },

    move: function() {
      this.children[this.getNextStrip()].stop().animate({
        'background-position-x': parseInt(this.children[this.currStrip].css('background-position-x')) + ((Math.floor(Math.random() * 3000) + -3000) * ((Math.floor(Math.random() * 2) + 0) == 1 ? 1 : -1)),
        opacity: (Math.floor(Math.random() * 9) + 1) / 10
      },
      Math.floor(Math.random() * 300) + 200, 'linear' /*'easeInOutCirc' */);
    },

    deactivate: function() {
      var that = this;
      this.elem.fadeOut(700, function() {
        clearTimeout(that.timer);
      });
    }
  };

});
