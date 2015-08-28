var SELECT_TAG = "select";
var DIV_TAG = "div";
var ELEMENT_NODE = 1;

var Aria = {
  ROLE: "role",
  HAS_POPUP: "aria-haspopup",
  HIDDEN: "aria-hidden",
  LABELLED_BY: "aria-labelledby",
  SET_SIZE: "aria-setsize",
  SELECTED: "aria-selected",
  POSITION_IN_SET: "aria-posinset",
  OWNS: "aria-owns",
  ACTIVE_DESCENDANT: "aria-activedescendant",
  DISABLED: "aria-disabled",
  EXPANDED: "aria-expanded",
  Roles: {
    LISTBOX: "listbox",
    OPTION: "option",
    PRESENTATION: "presentation"
  }
};

var Keys = {
  ESCAPE: 27,
  ENTER: 13,
  TAB: 9,
  SPACE: 32,
  LEFT_ARROW: 37,
  UP_ARROW: 38,
  RIGHT_ARROW: 39,
  DOWN_ARROW: 40
};

var ClassNames = {
  MAIN_CONTAINER: "x-select",
  SELECT_WRAPPER: "x-select-select-wrapper",
  OPTION_HIGHLIGHTED: "x-select-option-highlighted",
  OPTION_SELECTED: "x-select-option-selected",
  DROPDOWN_INTERACTED: "x-select-dropdown-interacted"
};

var matchesImplementationName = (function() {
  var element = document.createElement("div"),
      implementationNames;

  implementationNames = [
    "matches", "matchesSelector", "webkitMatchesSelector",
    "mozMatchesSelector", "msMatchesSelector","oMatchesSelector"
  ];

  return implementationNames.reduce(function(result, name) {
    return !result && (name in element) ? name : result;
  }, null);
})();

function XSelectElement(htmlSelectElement) {
  var selectElement = htmlSelectElement ? htmlSelectElement
                                        : document.createElement(SELECT_TAG);
  Object.defineProperties(this, {
    _instanceId: { value: this._getId() },
    _selectElement: { value: selectElement },
    _container: { value: null, writable: true },
    _highlightedIndex: { value: 0, writable: true },
    _dropdownVisible: { value: false, writable: true },
    _disabled: { value: false, writable: true }
  });

  this._initialize();
  this._populate();
  this.selectedIndex = this._selectElement.selectedIndex;
}

Object.defineProperty(XSelectElement, "_nextId", { value: 1, writable: true });

Object.defineProperties(XSelectElement.prototype, {
  autofocus: {
    get: function() { return this._selectElement.autofocus; },
    set: function(value) { this._selectElement.autofocus = value; },
    enumerable: true
  },

  disabled: {
    get: function() { return this._selectElement.disabled; },
    set: function(value) {
      this._selectElement.disabled = value;

      this._disabled = value;

      this._selector.setAttribute(Aria.DISABLED, this._disabled ? "true" : "false");
    },
    enumerable: true
  },

  form: {
    get: function() { return this._selectElement.form; },
    enumerable: true
  },

  name: {
    get: function() { return this._selectElement.name; },
    set: function(value) { this._selectElement.name = value; },
    enumerable: true
  },

  required: {
    get: function() { return this._selectElement.required; },
    set: function(value) { this._selectElement.required = value; },
    enumerable: true
  },

  size: {
    get: function() { return this._selectElement.size; },
    set: function(value) { this._selectElement.size = value; },
    enumerable: true
  },

  type: {
    get: function() { return this._selectElement.type; },
    enumerable: true
  },

  options: {
    get: function() { return this._selectElement.options; },
    enumerable: true
  },

  length: {
    get: function() { return this._selectElement.size; },
    set: function(value) { this._selectElement.size = value; },
    enumerable: true
  },

  item: {
    value: function(index) {
      return this._selectElement.item(index);
    },
    enumerable: true
  },

  value: {
    get: function() { return this._selectElement.value; },
    set: function(value) {
      this._selectElement.value = value;
      this.selectedIndex = this._selectElement.selectedIndex;
    },
    enumerable: true
  },

  selectedIndex: {
    get: function() { return this._selectElement.selectedIndex; },
    set: function(value) {
      var currentlySelected = this._dropdown.querySelector("[" + Aria.SELECTED + "=\"true\"]"),
          newlySelected = this._dropdown.querySelector("[" + Aria.POSITION_IN_SET + "=\"" + (value + 1) + "\"]");

      if (currentlySelected) {
        currentlySelected.setAttribute(Aria.SELECTED, "false");
      }

      newlySelected.setAttribute(Aria.SELECTED, "true");
      this._selectElement.selectedIndex = value;
      var event = new Event('change', {
        'view': window,
        'bubbles': true,
        'cancelable': true
      });
      this._selectElement.dispatchEvent(event);
      this._selectorLabel.innerHTML = "";
      this._selectorLabel.appendChild(document.createTextNode(newlySelected.textContent || newlySelected.innerText));
      this._selector.setAttribute(Aria.ACTIVE_DESCENDANT, newlySelected.id);
      this._highlightIndex(value);
    },
    enumerable: true
  },

  containerElement: {
    get: function() { return this._container; },
    enumerable: true
  },

  _initialize: {
    value: function() {
      var container = this._initializeContainer(),
          selector = this._initializeSelector(),
          dropdown = this._initializeDropdown();

      selector.setAttribute(Aria.OWNS, dropdown.id);

      container.appendChild(selector);
      container.appendChild(dropdown);

      selector.addEventListener("click", function(event) {
        if (!this._disabled) {
          if (this._dropdownVisible) {
            this._hideDropDown();
          } else {
            this._showDropDown();
          }
        }
      }.bind(this), false);

      document.body.addEventListener("click", function(event) {
        var target = event.target;

        while (target && target !== document.body) {
          if (target === container) {
            return;
          }
          target = target.parentNode;
        }

        if (this._dropdownVisible) {
          this._hideDropDown();
          this._highlightIndex(this.selectedIndex);
        }
      }.bind(this), false);

      Object.defineProperty(this, "_container", { value: container });
      Object.defineProperty(this, "_selector", { value: selector });
      Object.defineProperty(this, "_selectorLabel", { value: selector.querySelector("[data-label]") });
      Object.defineProperty(this, "_dropdown", { value: dropdown });

      this.disabled = this._selectElement.disabled;
    }
  },

  _initializeContainer: {
    value: function() {
      var container = document.createElement(DIV_TAG),
          selectWrapper = document.createElement(DIV_TAG);

      container.className = ClassNames.MAIN_CONTAINER;

      selectWrapper.className = ClassNames.SELECT_WRAPPER;
      selectWrapper.setAttribute(Aria.HIDDEN, "true");

      this._selectElement.parentNode.insertBefore(container, this._selectElement.nextSibling);
      this._selectElement.parentNode.removeChild(this._selectElement);
      this._selectElement.setAttribute(Aria.HIDDEN, "true");
      this._selectElement.setAttribute(Aria.EXPANDED, "false");

      selectWrapper.appendChild(this._selectElement);
      container.appendChild(selectWrapper);

      return container;
    }
  },

  _initializeSelector: {
    value: function() {
      var selector = document.createElement(DIV_TAG),
          label = document.createElement(DIV_TAG),
          arrow = document.createElement(DIV_TAG),
          labelId = "x-select-" + this._instanceId + "-selector-label-" + this._getId();

      selector.tabIndex = this._selectElement.tabIndex;
      selector.className = this._selectElement.className;
      selector.id = this._selectElement.id;
      selector.setAttribute(Aria.ROLE, Aria.Roles.LISTBOX);
      selector.setAttribute(Aria.HAS_POPUP, "true");
      selector.setAttribute(Aria.LABELLED_BY, labelId);
      selector.setAttribute("data-select", "");

      label.id = labelId;
      label.setAttribute("data-label", "");

      arrow.setAttribute(Aria.ROLE, Aria.Roles.PRESENTATION);
      arrow.setAttribute("data-arrow", "");
      arrow.appendChild(document.createTextNode("▼"));

      this._selectElement.tabIndex = -1;
      this._selectElement.removeAttribute("className");
      this._selectElement.removeAttribute("id");

      selector.addEventListener("keypress", function(event) {
        var code = event.keyCode || event.which,
            selectedOption;

        if (code === Keys.SPACE) {
          event.preventDefault();
          if (this._dropdownVisible) {
            this.selectedIndex = this._highlightedIndex;
            this._hideDropDown();
          } else {
            this._showDropDown();
          }
        } else if (code === Keys.ENTER && this._dropdownVisible) {
          this.selectedIndex = this._highlightedIndex;
          this._hideDropDown();
        }
      }.bind(this), false);

      selector.addEventListener("keydown", function(event) {
        var code = event.keyCode || event.which,
            selectedOption;

        if (code === Keys.TAB) {
          this._hideDropDown();
          this._highlightIndex(this.selectedIndex);
        } else if (code === Keys.ESCAPE) {
          this._hideDropDown();
          this._highlightIndex(this.selectedIndex);
        } else if (code === Keys.UP_ARROW && this._dropdownVisible) {
          event.preventDefault();
          this._dropdown.classList.add(ClassNames.DROPDOWN_INTERACTED);
          this._highlightIndex(this._highlightedIndex - 1);
        } else if (code === Keys.DOWN_ARROW && this._dropdownVisible) {
          event.preventDefault();
          this._dropdown.classList.add(ClassNames.DROPDOWN_INTERACTED);
          this._highlightIndex(this._highlightedIndex + 1);
        }
      }.bind(this), false);

      selector.appendChild(label);
      selector.appendChild(arrow);

      return selector;
    }
  },

  _initializeDropdown: {
    value: function() {
      var dropdown = document.createElement(DIV_TAG),
          id = "x-select-" + this._instanceId + "-dropdown-" + this._getId();

      dropdown.id = id;
      dropdown.setAttribute(Aria.HIDDEN, "true");
      dropdown.setAttribute("data-dropdown", "");


      dropdown.addEventListener("mouseover", function(event) {
        var target = event.target,
            related = event.relatedTarget,
            match;

        dropdown.classList.add(ClassNames.DROPDOWN_INTERACTED);

        while (target && target !== document && !(match = target[matchesImplementationName]("[data-option]"))) {
          target = target.parentNode;
        }

        if (!match) {
          return;
        }

        while (related && related !== target && related !== document) {
          related = related.parentNode;
        }

        if ( related == target ){
          return;
        }

        this._highlightIndex(parseInt(target.getAttribute(Aria.POSITION_IN_SET)) - 1);
      }.bind(this), false);

      dropdown.addEventListener("mouseout", function(event) {
        var target = event.target,
            related = event.relatedTarget,
            match;

        while (target && target !== document && !(match = target[matchesImplementationName]("[data-option]"))) {
          target = target.parentNode;
        }

        if (!match) {
          return;
        }

        while (related && related !== target && related !== document) {
          related = related.parentNode;
        }

        if ( related == target ){
          return;
        }

        target.classList.remove(ClassNames.OPTION_HIGHLIGHTED);
      }, false);

      dropdown.addEventListener("click", function(event) {
        var target = event.target,
            match;

        while (target && target !== document && !(match = target[matchesImplementationName]("[data-option]"))) {
          target = target.parentNode;
        }

        if (!match) {
          return;
        }

        this._hideDropDown();
        this.selectedIndex = this._highlightedIndex;
        this._selector.focus();
      }.bind(this), false);

      return dropdown;
    }
  },

  _populate: {
    value: function() {
      var selectOptions = this._selectElement.options,
          fragment = document.createDocumentFragment(),
          selectedOption,
          selectedOptionLabel,
          selectedIndex = 0,
          option,
          i,
          length;

      for (i = 0, length = selectOptions.length; i < length; i++) {
        option = this._createOption(selectOptions[i]);
        option.setAttribute(Aria.SET_SIZE, length);
        option.setAttribute(Aria.POSITION_IN_SET, i + 1);
        option.setAttribute(Aria.SELECTED, selectOptions[i].selected ? "true" : "false");

        if (selectOptions[i].selected) {
          selectedIndex = i;
        }

        fragment.appendChild(option);
      }

      this._dropdown.appendChild(fragment);
    }
  },

  _createOption: {
    value: function(htmlOptionElement) {
      var option = document.createElement(DIV_TAG),
          label = document.createTextNode(htmlOptionElement.textContent || htmlOptionElement.innerText);

      option.appendChild(label);
      option.setAttribute(Aria.ROLE, Aria.Roles.OPTION);
      option.setAttribute("data-option", "");
      option.id = "x-select-" + this._instanceId + "-dropdown-option-" + this._getId();

      return option;
    }
  },

  _showDropDown: {
    value: function() {
      this._selector.setAttribute(Aria.EXPANDED, "true");
      this._dropdown.setAttribute(Aria.HIDDEN, "false");
      this._dropdownVisible = true;
    }
  },

  _hideDropDown: {
    value: function() {
      this._selector.setAttribute(Aria.EXPANDED, "false");
      this._dropdown.setAttribute(Aria.HIDDEN, "true");
      this._dropdownVisible = false;
      this._dropdown.classList.remove(ClassNames.DROPDOWN_INTERACTED);
    }
  },

  _highlightIndex: {
    value: function(value) {
      var currentOption = this._dropdown.querySelector("[" + Aria.POSITION_IN_SET + "=\"" + (this._highlightedIndex + 1) + "\"]"),
          newOption;

      if (value < 0) {
        value = 0;
      }

      if (value >= this._selectElement.options.length) {
        value = this._selectElement.options.length - 1;
      }

      newOption = this._dropdown.querySelector("[" + Aria.POSITION_IN_SET + "=\"" + (value + 1) + "\"]");

      if (currentOption) {
        currentOption.classList.remove(ClassNames.OPTION_HIGHLIGHTED);
      }

      if (newOption) {
        newOption.classList.add(ClassNames.OPTION_HIGHLIGHTED);
        this._highlightedIndex = value;
      }
    }
  },

  _getId: {
    value: function() {
      var id = (this.constructor._nextId++).toString(),
          ID_LENGTH = 5;

      return Array.apply(Array, Array(ID_LENGTH - id.length))
                  .map(function () { return "0"; })
                  .join("") + id;
    }
  }
});

module.exports = XSelectElement;

