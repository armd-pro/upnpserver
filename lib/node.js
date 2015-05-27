/*jslint node: true, plusplus: true, nomen: true, vars: true */
/*global setImmediate*/
"use strict";

var assert = require('assert');
var Util = require("util");
var Async = require("async");
var _ = require('underscore');
var Item = require('./class/object.item');

var debugFactory = require('debug');
var debug = debugFactory('upnpserver:node');
var debugGarbage = debugFactory('upnpserver:garbage');

var logger = require('./logger');

// IT MUST START AT 0 because UPNP ROOT must have id 0
var nodeIndex = 0;
var emptyMap = {};

var LOG_LIST_CHILDREN = false;
var LOG_GET_CHILD_BYNAME = false;

var Node = function(service, id) {
  assert(service, "Service is undefined !");

  this.id = (id !== undefined) ? id : nodeIndex++;
  this.service = service;
};

Node.createRef = function(linkedNode, name) {
  var node = new Node(linkedNode.service);

  node.refID = linkedNode.id;
  if (name) {
    node.name = name;
  }

  if (debug.enabled) {
    debug("NewNodeRef id=" + node.id + " name=" + name + " linkedName=" +
        linkedNode.name);
  }
  return node;
};

Node.create = function(service, name, upnpClass, attributes) {
  var node = new Node(service);

  node.updateId = 0;

  if (name) {
    node.name = name;
  }
  if (attributes) {
    node.attributes = attributes;
  }

  assert(upnpClass instanceof Item, "UpnpClass must be an item " +
      upnpClass.name);
  node.upnpClass = upnpClass;

  node.updateId = 0;

  if (attributes && attributes.virtual) {
    node.virtual = true;
  }

  if (debug.enabled) {
    debug("NewNode id=" + node.id + " name=" + name + " upnpClass=" + upnpClass);
  }

  return node;
};

module.exports = Node;

Node.prototype._disconnectChildren = function(childrenIds, callback) {
  if (!childrenIds || !childrenIds.length) {
    setImmediate(callback);
    return;
  }

  var service = this.service;

  Async.eachSeries(childrenIds, function(childId, callback) {
    service.getNodeById(childId, function(error, node) {
      if (error) {
        return callback(error);
      }

      delete node.path;
      node.updateId++;

      // service.registerUpdate(node);

      service.unregisterNode(node, callback);

    }, callback);
  });
};

Node.prototype.removeChild = function(child, callback) {

  var childrenIds = this._childrenIds;
  if (!childrenIds) {
    throw new Error("The node has no children");
  }

  var idx = childrenIds.indexOf(child.id);
  if (idx < 0) {
    throw new Error("Can not find child #" + child.id);
  }

  var service = this.service;
  var self = this;

  this._disconnectChildren(child._childrenIds || [], function(error) {
    if (error) {
      return callback(error);
    }

    self._childrenIds.splice(idx, 1);
    delete child.path;
    delete child.parentId;

    self.updateId++;

    service.registerUpdate(self);

    service.unregisterNode(child, callback);
  });
};

Node.prototype.appendChild = function(child, callback) {
  this.insertBefore(child, null, callback);
};

Node.prototype.insertBefore = function(child, before, callback) {

  if (typeof (child.parentId) === "number") {
    throw new Error("Can not add a child which has already a parent !");
  }
  child.parentId = this.id;

  if (!this._childrenIds) {
    this._childrenIds = [];
  }

  var idx = this._childrenIds.length;
  if (before) {
    idx = this._childrenIds.indexOf(before.id);
    if (idx < 0) {
      throw new Error("Before child #" + before.id + " is not found");
    }
  }

  this._childrenIds.splice(idx, 0, child.id);
  this.updateId++;

  if (!this.path) {
    // Node is not connected to the root !
    return callback();
  }

  var path = this.path;
  if (path !== "/") {
    path = path + "/";
  }
  path += child.name ? child.name : child.id;

  child.path = path;

  this.service.registerUpdate(this);

  this.service.registerNode(child, callback);

  if (child._childrenIds) {
    // TODO Connect children
  }
};

Node.prototype.toJSON = function() {
  var obj = {
    id : this.id,
    parentID : this.parentId
  };

  if (this.name) {
    obj.name = this.name;
  }

  if (this.upnpClass) {
    obj.upnpClass = this.upnpClass.name;
  }

  if (this.updateId) {
    obj.updateId = this.updateId;
  }

  if (this.refID) {
    obj.refID = this.refID;
  }
  if (this.attributes && this.attributes !== emptyMap) {
    obj.attributes = this.attributes;
  }
  if (this.virtual) {
    obj.virtual = true;
  }
  if (this._childrenIds) {
    obj.childrenIds = this._childrenIds;
  }

  return JSON.stringify(obj);
};

Node.prototype.fromChildJSON = function(string, callback) {

  var obj = JSON.parse(string);

  var service = this.service;

  var node = new Node(service, obj.id);
  if (obj.name) {
    node.name = obj.name;
  }

  if (obj.upnpClass) {
    node.upnpClass = service.upnpClasses[obj.upnpClass];
  }

  if (obj.contentProvider) {
    node.contentProvider = service.contentProviders[obj.contentProvider];
  }

  node.attributes = obj.attributes || {};

  if (obj.updateId) {
    node.updateId = obj.updateId;
  }
  if (obj.refID) {
    node.refID = obj.refID;
  }
  if (obj.virtual) {
    node.virtual = true;
  }
  if (obj._childrenIds) {
    node._childrenIds = obj.childrenIds;
  }

  this.appendChild(node, callback);
};

Node.prototype.listChildren = function(options, callback) {
  if (typeof (options) === "function") {
    callback = options;
    options = undefined;
  }
  options = options || {};

  var self = this;

  var service = this.getService();

  var cache = service._childrenWeakHashmap.get(this);
  if (cache) {
    return callback(null, cache);
  }

  if (this._locked) {
    setImmediate(function() {
      self.listChildren(options, callback);
    });
    return;
  }

  assert(this.upnpClass.isContainer, "Node is not a container  (id=" + this.id +
      ")");
  if (!this.upnpClass.isContainer) {
    if (LOG_LIST_CHILDREN) {
      logger.debug("Node.listChildren[" + self + "]  => No container");
    }
    return callback(null, null);
  }

  this._locked = true;

  if (this._childrenIds !== undefined) {
    if (LOG_LIST_CHILDREN) {
      logger.debug("Node.listChildren[" + self + "]  => cache ",
          this._childrenIds.length);
    }

    var getNodeFunc = function(id, callback) {
      service.getNodeById(id, callback);
    };
    if (options.resolveLinks) {
      var old = getNodeFunc;
      getNodeFunc = function(id, callback) {
        old(id, function(error, node) {
          if (error) {
            return callback(error);
          }

          node.resolveLink(callback);
        });
      };
    }

    Async.mapLimit(this._childrenIds, 4, getNodeFunc,
        function(error, result) {
          self._locked = undefined;

          if (error) {
            if (debug.enabled) {
              debug("Node.listChildren[" + self + "] => map returs error ",
                  error);
            }
            return callback(error);
          }

          if (LOG_LIST_CHILDREN) {
            logger.debug("Node.listChildren[" + self + "] => map returs " +
                result);
          }

          service._childrenWeakHashmap.put(self, result);

          callback(null, result);
        });
    return;
  }

  if (LOG_LIST_CHILDREN) {
    logger.debug("Node.listChildren[" + self + "] => not in cache !");
  }

  // this._childrenIds = [];
  service.browseNode(this, function(error, list) {
    self._locked = undefined;

    if (error) {
      return callback(error);
    }

    if (LOG_LIST_CHILDREN) {
      logger.debug("Node.listChildren[" + self + "] => ", list);
    }

    service._childrenWeakHashmap.put(self, list);

    return callback(null, list);
  });
};

Node.prototype.getPath = function() {
  return this.path;
};

Node.prototype.getService = function() {
  return this.service;
};

Node.prototype.getParent = function(callback) {
  if (!this.parentId) {
    return callback(null, null);
  }

  var service = this.getService();

  return service.getNodeById(this.parentId, callback);
};

Node.prototype.getChildByName = function(name, callback) {
  var self = this;

  this.listChildren(function(error, children) {
    if (error) {
      if (debug.enabled) {
        debug("Node.getChildByName[" + self + "] (" + name + ") => error ",
            error);
      }
      return callback(error);
    }

    var links;

    for (var i = 0; i < children.length; i++) {
      var child = children[i];

      if (child.name === name) {
        if (LOG_GET_CHILD_BYNAME) {
          logger.debug("Node.getChildByName[" + self + "] (" + name +
              ") => find " + child);
        }
        return callback(null, child);
      }

      if (child.name === undefined && child.refID) {
        if (!links) {
          links = [];
        }
        links.push(child);
        continue;
      }
    }

    if (!links) {
      if (LOG_GET_CHILD_BYNAME) {
        logger.debug("Node.getChildByName[" + self + "] (" + name +
            ") => NO RESULT");
      }

      return callback();
    }

    Async.eachSeries(links, function(link, callback) {

      link.resolveLink(function(error, node) {
        if (error) {
          return callback(error);
        }

        if (node.name === name) {
          return callback(link);
        }

        callback();
      });
    }, function(error) {
      if (error) {
        if (error.refID) {
          // It is the found node !
          return callback(null, error);
        }

        return callback(error);
      }

      callback();
    });

  });
};

Node.prototype.resolveLink = function(callback) {
  if (!this.refID) {
    return callback(null, this);
  }

  var self = this;
  setImmediate(function() {
    self.service.getNodeById(this.refID, function(error, child) {
      if (error) {
        return callback(error);
      }

      child.resolveLink(callback);
    });
  });
};

Node.prototype.addSearchClass = function(searchClass, includeDerived) {
  if (!this.searchClasses) {
    this.searchClasses = [];
  }

  this.searchClasses.push({
    name : searchClass,
    includeDerived : includeDerived
  });
};
/*
 * Node.prototype.setDate = function(date) { if (!date) { this._date = undefined; return; } this._date = Node.toISODate(date); };
 * 
 * Node.toISODate = function(date) { return date.toISOString().replace(/\..+/, ''); };
 */

Node.prototype.treeString = function(callback) {
  return this._treeString("", callback);
};

Node.prototype._treeString = function(indent, callback) {
  // logger.debug("TreeString " + this);

  indent = indent || "";

  var s = indent + "# " + this + "\n";
  if (!this.upnpClass || !this.upnpClass.isContainer) {
    return callback(null, s);
  }

  indent += "  ";
  if (!this._childrenIds) {
    if (!this.refID) {
      s += indent + "<Unknown children>\n";
    }
    return callback(null, s);
  }

  var service = this.getService();

  Async.eachSeries(this._childrenIds, function(childId, callback) {
    service.getNodeById(childId, function(error, child) {
      if (error) {
        return callback(error);
      }

      child._treeString(indent, function(error, s2) {
        if (s2) {
          s += s2;
        }

        callback(null);
      });
    });

  }, function(error) {
    callback(error, s);
  });
};

Node.prototype.update = function(callback) {
  if (debug.enabled) {
    debug("Update item itemId=" + this.id + " name=" + this.name);
  }
  // this.getService().updateNode(this, callback);
  callback(null);
};

Node.prototype.garbage = function(callback) {

  var service = this.getService();

  if (!this._childrenIds) {
    if (callback) {
      callback();
    }
    return;
  }

  var self = this;
  Async.each(this._childrenIds, function(child, callback) {
    service.getNodeById(child, function(error, item) {
      if (error || !item) {
        return callback(error);
      }

      if (item.virtual) {
        if (!item.upnpClass.isContainer) {
          return callback(null);
        }
        return item.garbage(callback);
      }

      // clean it ! (remove all children for reload)
      self.updateId++;
      service.registerUpdate(self);

      item._garbageChild(callback);
    });

  }, function(error) {
    if (callback) {
      callback(error);
    }
  });
};

Node.prototype._garbageChild = function(callback) {

  var service = this.getService();

  if (!this.upnpClass.isContainer || !this._childrenIds) {
    if (debugGarbage.enabled) {
      debugGarbage("Garbage id " + this.id + " " + this.name);
    }
    return service.unregisterNodeById(this.id, callback);
  }

  var self = this;
  Async.each(this._childrenIds, function(child, callback) {
    service.getNodeById(child, function(error, item) {
      item._garbageChild(callback);
    });

  }, function(error) {
    if (error) {
      return callback(error);
    }

    self._childrenIds = null;

    if (debugGarbage.enabled) {
      debugGarbage("Garbage id " + self.id + " " + self.name);
    }

    return service.unregisterNodeById(self.id, callback);
  });
};

Node.prototype.toString = function() {
  var s = "[Node id=" + this.id;

  // s += " path=" + this.path;

  if (this.upnpClass) {
    s += " upnpClass='" + this.upnpClass + "'";
  }

  if (this.name) {
    s += " name='" + this.name + "'";
  }

  if (this.refID) {
    s += " refID=" + this.refID;

  } else if (this.attributes.virtual) {
    s += " VIRTUAL";
  }

  return s + "]";
};