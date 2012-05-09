/*
* Copyright (c) 2012 Walmart. All rights reserved. Copyrights licensed under the New BSD License.
* See LICENSE file included with this code project for license terms.
*/

// Load modules

var Fs = require('fs');
var Http = require('http');
var Https = require('https');
var Url = require('url');
var Querystring = require('querystring');
var NodeUtil = require('util');
var Events = require('events');
var Director = require('director');
var MAC = require('mac');
var Utils = require('./utils');
var Err = require('./error');
var Log = require('./log');
var Process = require('./process');
var Validation = require('./validation');
var Defaults = require('./defaults');
var Monitor = require('./monitor');
var Session = require('./session');


// Declare internals

var internals = {

    // Servers instances by uri or name

    servers: {}
};


// Create and configure server instance

exports.Server = Server = function (host, port, options, routes) {

    var that = this;

    // Confirm that Server is called as constructor

    if (this.constructor != Server) {

        console.log("Please instantiate Server() with new (var x = new Server()).");
        process.exit(1);
    }

    // Register as event emitter

    Events.EventEmitter.call(this);

    // Set basic configuration

    this.settings = Utils.merge(Utils.clone(Defaults.server), options || {});
    this.settings.host = host.toLowerCase();
    this.settings.port = port;
    this.settings.name = (this.settings.name ? this.settings.name.toLowerCase() : (this.settings.host + ':' + this.settings.port));
    this.settings.uri = (this.settings.tls ? 'https://' : 'http://') + this.settings.host + ':' + this.settings.port + '/';

    // Initialize authentication configuration and validate

    if (this.settings.authentication) {

        this.settings.authentication = Utils.merge(Utils.clone(Defaults.authentication), this.settings.authentication);

        if (this.settings.authentication.tokenEndpoint === null ||
            this.settings.authentication.loadClientFunc === null ||
            this.settings.authentication.loadUserFunc === null ||
            this.settings.authentication.checkAuthorizationFunc === null ||
            this.settings.authentication.aes256Keys.oauthRefresh === null ||
            this.settings.authentication.aes256Keys.oauthToken === null) {

            Log.err('Invalid authentication configuration');
            process.exit(1);
        }
    }

    // Verify no existing instances using the same uri or name

    if (internals.servers[this.settings.name]) {

        Log.err('Cannot configure multiple server instances using the same name or uri');
        process.exit(1);
    }

    // Add to instance list

    internals.servers[this.settings.name] = this;

    // Initialize Log downstream if set

    this.monitor = null;

    if (this.settings.monitor) {

        this.monitor = new Monitor(this);

        if (this.settings.monitor.ops &&
            this.settings.monitor.interval &&
            Object.keys(this.settings.monitor.ops).length > 0) {

            this.on('ops', this.monitor.handle('ops'));
            this.monitor_interval = setInterval((function(){

                this.emit('ops');
            }), this.settings.monitor.interval);
        }
        
        if (this.settings.monitor.request &&
            Object.keys(this.settings.monitor.request).length > 0) {

            this.on('request', this.monitor.handle('request'));
            this.on('replied', function(hapi) {

                this.emit('request', hapi.request, hapi.response)
            })
        }
        
        if (this.settings.monitor.log &&
            Object.keys(this.settings.monitor.log).length > 0) {

            Log.externalStores = this.settings.monitor.log;
        }
    }

    // Create router

    this.router = new Director.http.Router();
    this.router.configure({

        async: true,
        notfound: this.unhandledRoute()
    });
    

    var listenerEntryFunc = function (req, res) {

        that.router.dispatch(req, res, function (err) {

            if (err) {

                // Should never get called since 'notfound' is set

                Log.err('Internal routing error');
                res.writeHead(500);
                res.end();
            }
        });
    };

    // Create server

    if (this.settings.tls) {

        var tls = {

            key: Fs.readFileSync(this.settings.tls.key),
            cert: Fs.readFileSync(this.settings.tls.cert)
        };

        this.listener = Https.createServer(tls, listenerEntryFunc);
    }
    else {

        this.listener = Http.createServer(listenerEntryFunc);
    }

    // Setup OPTIONS handler

    this.router.options(/.+/, function () {

        that.setCorsHeaders(this.res);
        internals.respond(this.res, 200);
    });

    // Setup OAuth token endpoint

    if (this.settings.authentication) {

        this.addRoute({

            method: 'POST',
            path: this.settings.authentication.tokenEndpoint,
            handler: Session.token,
            schema: Session.type.endpoint,
            mode: 'raw',
            authentication: 'optional',
            user: 'any',
            tos: 'none'
        });
    }

    // Add routes

    if (routes) {

        this.addRoutes(routes);
    }
};

NodeUtil.inherits(Server, Events.EventEmitter);


// Route preprocessor handler

Server.prototype.preRoute = function () {

    return function (req, res, next) {

        req._startTime = new Date; // Used to determine request response time 

        Log.info('Received', req);

        req.hapi = {};
        res.hapi = {};

        req.query = req.url.indexOf('?') >= 0 ? Url.parse(req.url, true).query : {};

        next();
    };
};


// Route validator

Server.prototype.routeValidator = function (config) {

    var that = this;

    return function (req, res, next) {

        // Authentication

        internals.authenticate(req, res, config, that, function (err) {

            if (err === null) {

                // Query parameters

                Validation.validateQuery(req, Utils.map(config.query), function (err) {

                    if (err === null) {

                        // Load payload

                        internals.processBody(req, config.payload || (config.schema ? 'parse' : null), that, function (err) {

                            if (err === null) {

                                // Validate payload schema

                                Validation.validateData(req, config.schema || null, function (err) {

                                    if (err) {

                                        res.hapi.error = err;
                                    }

                                    next();
                                });
                            }
                            else {

                                res.hapi.error = err;
                                next();
                            }
                        });
                    }
                    else {

                        res.hapi.error = err;
                        next();
                    }
                });
            }
            else {

                res.hapi.error = err;
                next();
            }
        });
    };
};


// Request handler wrapper

Server.prototype.routeHandler = function (config) {

    var that = this;

    return function (req, res, next) {

        if (!res.hapi.error) {

            // Link req stuff into hapi object

            req.hapi.url = req.url;
            req.hapi.query = req.query;
            req.hapi.params = req.params;
            req.hapi.server = that;

            var request = (config.mode === 'raw' ? req : req.hapi);

            config.handler(request, function (result, options) {

                res.hapi[result instanceof Error ? 'error' : 'result'] = result;
                res.hapi.options = options || {};
                next();
            });
        }
        else {

            next();
        }
    };
};


// Set default response headers and send response

Server.prototype.postRoute = function () {

    var that = this;

    return function (req, res, next) {

        that.setCorsHeaders(res);
        res.setHeader('Cache-Control', 'must-revalidate');

        if (res.hapi.result) {

            var rev = null;                         // Need to set to something useful
            if (req.method === 'GET' && rev) {

                res.setHeader('ETag', rev);

                var condition = internals.parseCondition(req.headers['if-none-match']);

                if (condition[rev] ||
                condition['*']) {

                    internals.respond(res, 304);
                }
                else {

                    internals.respond(res, 200, res.hapi.result);
                }
            }
            else if (res.hapi.options.created) {

                internals.respond(res, 201, res.hapi.result, { 'Location': that.settings.uri + res.hapi.options.created });
            }
            else {

                internals.respond(res, 200, res.hapi.result);
            }

            Log.info('Replied', req);
        }
        else if (req.hapi.error) {

            if (req.hapi.error.type === 'oauth') {

                internals.respond(res, req.hapi.error.code, { error: req.hapi.error.error, error_description: req.hapi.error.text });
            }
            else {

                internals.respond(res, req.hapi.error.code, { error: req.hapi.error.text, message: req.hapi.error.message, code: req.hapi.error.code });
            }

            Log.err(res.hapi.error, req);
        }
        else {

            internals.respond(res, 200);
            Log.info('Replied', req);
        }

        // Emit 'replied' event

        that.emit('replied', { request: req, response: res });

        // Return control to router

        next();
    };
};


// 404 Route handler

Server.prototype.unhandledRoute = function () {

    var that = this;
    var req = this.req;
    var res = this.res;

    return function (next) {

        req._startTime = new Date;                             // Used to determine request response time 

        if (that.settings.ext.onUnknownRoute) {

            that.settings.ext.onUnknownRoute(req, res, function () {

                // Emit 'replied' event

                that.emit('replied', { request: req, response: res });
                next();
            });
        }
        else {

            Log.info('Received', req);

            var error = Err.notFound('No such path or method');
            internals.respond(res, error.code, { error: error.text, message: error.message, code: error.code });

            Log.info(error, req);

            // Emit 'replied' event

            that.emit('replied', { request: req, response: res });
            next();
        }
    };
};


// Set CORS headers

Server.prototype.setCorsHeaders = function (res) {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-None-Match');
    res.setHeader('Access-Control-Max-Age', this.settings.cors.maxAge);
};


// Start server listener

Server.prototype.start = function () {

    this.listener.listen(this.settings.port, this.settings.host);
    Log.info(Process.settings.name + ' Server instance started at ' + this.settings.uri);
};


// Stop server

Server.prototype.stop = function () {

    this.listener.close();
    Log.info(Process.settings.name + ' Server instance stopped at ' + this.settings.uri);
};


// Set route defauts

Server.prototype.setRoutesDefaults = function (config) {

    this.routeDefaults = config;
};


// Add server route

Server.prototype.addRoute = function (config) {

    var routeConfig = (this.routeDefaults ? Utils.merge(Utils.clone(this.routeDefaults), config) : config);

    // Validate configuration

    if (!routeConfig.path) {

        Log.err('Route missing path');
        process.exit(1);
    }

    if (!routeConfig.method) {

        Log.err('Route missing method');
        process.exit(1);
    }

    if (!routeConfig.handler) {

        Log.err('Route missing handler');
        process.exit(1);
    }

    if (routeConfig.authentication !== 'none' &&
        this.settings.authentication === null) {

        Log.err('Route requires authentication but none configured');
        process.exit(1);
    }

    // Parse path to identify :parameter names, only if no other regex or wildcards are included

    var parameterNames = [];
    if (/\*|\(|\)/.test(routeConfig.path) === false) {

        var names = routeConfig.path.match(/:([^\/]+)/ig);
        if (names) {

            for (var i = 0, il = names.length; i < il; ++i) {

                parameterNames.push(names[i].slice(1));
            }
        }
    }

    // Handler wrapper

    var wrapper = function (func) {

        return function () {

            // Convert director arguements to parameters object

            if (arguments.length - 1 === parameterNames.length) {

                this.req.params = {};
                for (var i = 0, il = parameterNames.length; i < il; ++i) {

                    this.req.params[parameterNames[i]] = arguments[i];
                }
            }

            func(this.req, this.res, arguments[arguments.length - 1]);
        };
    };

    // Add route to Director

    this.router[routeConfig.method.toLowerCase()](routeConfig.path, { stream: true }, [

        wrapper(this.settings.ext.onPreRoute),
        wrapper(this.preRoute()),
        wrapper(this.routeValidator(routeConfig)),
        wrapper(this.settings.ext.onPreHandler),
        wrapper(this.routeHandler(routeConfig)),
        wrapper(this.settings.ext.onPostHandler),
        wrapper(this.postRoute()),
        wrapper(this.settings.ext.onPostRoute)]);
};


Server.prototype.addRoutes = function (routes) {

    for (var i = 0, il = routes.length; i < il; ++i) {

        this.addRoute(routes[i]);
    }
};


// Return server object

exports.instance = function (name) {

    if (name) {

        name = name.toLowerCase();

        var server = internals.servers[name];
        if (server) {

            return server;
        }
        else {

            return null;
        }
    }
    else {

        var names = Object.keys(internals.servers);
        if (names.length === 1) {

            return internals.servers[names[0]];
        }
        else if (names.length === 0) {

            return null;
        }
        else {

            Log.err('Cannot call Server.instance() without uri in a process with multiple server instances');
            process.exit(1);
        }
    }
};


// Return server object configuration

exports.settings = function (name) {

    var server = exports.instance(name);
    if (server) {

        return server.settings;
    }
    else {

        return null;
    }
};


// Add routes to multiple instances

exports.addRoutes = function (arg0, arg1) { // [defaultInstances,] routes

    // Handle optional arguments

    var defaultInstances = (arguments.length === 2 ? (arguments[0] instanceof Array ? arguments[0] : [arguments[0]]) : null);
    var routes = (arguments.length === 2 ? arguments[1] : arguments[0]);

    // Process each route

    routes = (routes instanceof Array ? routes : [routes]);
    for (var i = 0, il = routes.length; i < il; ++i) {

        var route = routes[i];
        if (route.instance || defaultInstances) {

            // Select instances

            var instances = (route.instance ? (route.instance instanceof Array ? route.instance : [route.instance]) : defaultInstances);
            for (var r = 0, rl = instances.length; r < rl; ++r) {

                var server = internals.servers[instances[r].toLowerCase()];
                if (server) {

                    server.addRoute(route);
                }
                else {

                    Log.err('Cannot find server instance: ' + instances[r]);
                    process.exit(1);
                }
            }
        }
        else {

            // All instances

            for (var s in internals.servers) {

                if (internals.servers.hasOwnProperty(s)) {

                    internals.servers[s].addRoute(route);
                }
            }
        }
    }
};


// Token Authentication

internals.authenticate = function (req, res, routeConfig, server, callback) {

    var scope = routeConfig.scope || null;
    var minTos = routeConfig.tos || server.settings.tos.min;
    var userMode = routeConfig.user || 'required';
    var isOptional = (routeConfig.authentication === 'optional');

    if (routeConfig.authentication === 'none') {

        callback(null);
        return;
    }

    var loadTokenFunc = function (token, callback) {

        Session.loadToken(server.settings.authentication.aes256Keys.oauthToken, token, callback);
    };

    MAC.authenticate(req, loadTokenFunc, { isHTTPS: server.settings.tls }, function (isAuthenticated, session, err) {

        if (isAuthenticated) {

            if (session) {

                req.hapi.session = session;

                if (session.client) {

                    req.hapi.clientId = session.client;

                    // Check scope

                    if (scope === null ||
                        session.scope[scope]) {

                        req.hapi.scope = session.scope;

                        if (userMode === 'any') {

                            // User Mode: any

                            callback(null);
                        }
                        else if (userMode === 'required') {

                            // User Mode: required

                            if (session.user) {

                                // Check TOS

                                if (minTos === 'none' ||
                                    (session.tos && session.tos >= minTos)) {

                                    req.hapi.userId = session.user;
                                    callback(null);
                                }
                                else {

                                    callback(Err.forbidden('Insufficient TOS accepted'));
                                }
                            }
                            else {

                                callback(Err.forbidden('Client token cannot be used on a user endpoint'));
                            }
                        }
                        else if (userMode === 'none') {

                            // User Mode: none

                            if (session.user) {

                                callback(Err.forbidden('User token cannot be used on a client endpoint'));
                            }
                            else {

                                callback(null);
                            }
                        }
                        else {

                            callback(Err.internal('Unknown endpoint user mode'));
                        }
                    }
                    else {

                        callback(Err.forbidden('Insufficient token scope (\'' + scope + '\' expected for client ' + session.client + ')'));
                    }
                }
                else {

                    callback(Err.internal('Missing client identifier in authenticated token'));
                }
            }
            else {

                callback(Err.internal('Missing user object in authenticated token'));
            }
        }
        else {

            // Unauthenticated

            if (isOptional &&
                !req.headers.authorization) {

                callback(null);
            }
            else {

                res.setHeader('WWW-Authenticate', MAC.getWWWAuthenticateHeader(err));
                callback(Err.generic(401, 'Invalid authentication', err));
            }
        }
    });
};


// Read and parse body

internals.processBody = function (req, level, server, callback) {

    // Levels are: 'none', 'raw', 'parse'
    // Default is 'parse' for POST and PUT otherwise 'none'

    level = level || (req.method === 'POST' || req.method === 'PUT' ? 'parse' : 'none');

    if (level === 'none') {

        return callback(null);
    }

    // Check content type (defaults to 'application/json')

    var contentType = req.headers['content-type'];
    var mime = (contentType ? contentType.split(';')[0] : 'application/json');
    var parserFunc = null;

    if (mime === 'application/json') {

        parserFunc = JSON.parse;
    }
    else if (mime === 'application/x-www-form-urlencoded') {

        parserFunc = Querystring.parse;
    }
    else {

        return callback(Err.badRequest('Unsupported content-type: ' + mime));
    }

    // Check content size

    var contentLength = req.headers['content-length'];
    if (contentLength &&
        parseInt(contentLength, 10) > server.settings.payload.maxBytes) {

        return callback(Err.badRequest('Payload content length greater than maximum allowed: ' + server.settings.payload.maxBytes));
    }

    // Read incoming payload

    var payload = '';
    var isBailed = false;

    req.setEncoding('utf8');
    req.addListener('data', function (chunk) {

        if (payload.length + chunk.length <= server.settings.payload.maxBytes) {

            payload += chunk;
        }
        else {

            isBailed = true;
            return callback(Err.badRequest('Payload size greater than maximum allowed: ' + server.settings.payload.maxBytes));
        }
    });

    req.addListener('end', function () {

        if (isBailed) {

            return;
        }

        req.hapi.rawBody = payload;

        if (level === 'parse') {

            if (payload) {

                req.hapi.payload = {};

                try {

                    req.hapi.payload = parserFunc(payload);
                }
                catch (err) {

                    return callback(Err.badRequest('Invalid JSON body'));
                }

                callback(null);
            }
        }
    });
};


// Parse If-None-Match request header

internals.parseCondition = function (condition) {

    if (condition) {

        result = {};

        var conditionRegex = (condition.indexOf('"') !== -1 ? /(?:^|,)(?:\s*")([^"]+)(?:"\s*)/g : /(?:^|,)(?:\s*)([^\s]+)(?:\s*)/g);
        condition.replace(conditionRegex, function ($0) {

            if ($0) {

                result[$0] = true;
            }
        });

        return result;
    }
    else {

        return {};
    }
};


// Format and send HTTP response

internals.respond = function (res, code, payload, headers) {

    headers = headers || {};
    var data = null;

    if (payload) {

        if (typeof payload === 'object') {

            // Object

            headers['Content-Type'] = 'application/json';
            data = JSON.stringify(payload);
        }
        else {

            // String

            headers['Content-Type'] = 'text/plain';
            data = payload;
        }

        headers['Content-Length'] = Buffer.byteLength(data);
    }

    res.writeHeader(code, headers);
    res.end(data);
};
