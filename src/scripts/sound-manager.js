'use strict';

import Sound from './sound';


const fetchLocal = (url) => {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.addEventListener('load', function(event) {
      resolve(xhr.response);
    });

    xhr.addEventListener('error', reject);
    xhr.send();
  });
};

const decodeAudioData = (context, buffer) => {
  return new Promise((resolve, reject) => {
    context.decodeAudioData(buffer, decodedBuffer => {
      if (!decodedBuffer) {
        throw new Error("Unable to decode buffer");
      }

      resolve(decodedBuffer);
    });
  });
};


const _audioContext = Symbol('audio context');
const _gainNode = Symbol('gain node');
const _volume = Symbol('volume');
const _sounds = Symbol('sounds');
const _muted = Symbol('muted');

export default class SoundManager {

  constructor(volume = 1, muted = false) {
    this[_audioContext] = new webkitAudioContext();
    this[_gainNode] = this[_audioContext].createGain();
    this[_gainNode].connect(this[_audioContext].destination);
    this[_gainNode].gain.value = volume;
    this[_volume] = volume;
    this[_muted] = muted;
    this[_sounds] = new Map();
  }

  load(id, path) {
    const sound = fetchLocal(path)
      .then(buffer => decodeAudioData(this[_audioContext], buffer))
      .then((audioBuffer) => new Sound(this, id, path, audioBuffer));

    if (this[_sounds].has(id)) {
      throw new Error('Duplicate Sound Identifier');
    } 

    this[_sounds].set(id, sound);

    return this;
  }

  getSound(id) {
    if (!this[_sounds].has(id)) {
      return Promise.reject('Sound not found');
    }

    return this[_sounds].get(id);
  }

  get context() {
    return this[_audioContext];
  }

  get gain() {
    return this[_gainNode];
  }

  get muted() {
    return this[_muted];
  }

  mute() {
    this[_gainNode].gain.value = 0;
    this[_muted] = true;
  }

  unmute() {
    this[_gainNode].gain.value = this[_volume];
    this[_muted] = false;
  }

}
