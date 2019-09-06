(function(module) {
  "use strict";

  var User = module.parent.require('./user'),
    meta = module.parent.require('./meta'),
    db = module.parent.require('../src/database'),
    passport = module.parent.require('passport'),
    passportInstagram = require('passport-instagram').Strategy,
    async = module.parent.require('async'),
    winston = module.parent.require('winston'),
    nconf = module.parent.require('nconf');

  var constants = Object.freeze({
    'name': "Instagram",
    'admin': {
      'route': '/plugins/sso-instagram',
      'icon': 'fa-instagram'
    }
  });

  var Instagram = {};

  Instagram.init = function(params, callback) {
    function render(req, res, next) {
      res.render('admin/plugins/sso-instagram', {});
    }

    params.router.get('/admin/plugins/sso-instagram', params.middleware.admin.buildHeader, render);
    params.router.get('/api/admin/plugins/sso-instagram', render);

    callback();
  };

  Instagram.getStrategy = function(strategies, callback) {
    meta.settings.get('sso-instagram', function(err, settings) {
      if (!err && settings['id'] && settings['secret']) {
        passport.use(new passportInstagram({
          clientID: settings['id'],
          clientSecret: settings['secret'],
          passReqToCallback: true,
          callbackURL: nconf.get('url') + '/auth/instagram/callback'
        }, function(req, accessToken, refreshToken, profile, done) {

          // user is connecting instagram to existing account
          if (req.hasOwnProperty('user') && req.user.hasOwnProperty('uid') && req.user.uid > 0) {

            User.setUserField(req.user.uid, 'instagramId', profile.id);
            db.setObjectField('instagramId:uid', profile.id, req.user.uid);

            Instagram.storeInfo(req.user.uid, accessToken, profile.username);

            return done(null, req.user);
          }

          Instagram.login(profile.id, profile.username, profile.displayName, profile._json.data.profile_picture, profile._json.data.website, accessToken, function(err, user) {
            if (err) {
              return done(err);
            }
            done(null, user);
          });
        }));

        strategies.push({
          name: 'instagram',
          url: '/auth/instagram',
          callbackURL: '/auth/instagram/callback',
          icon: 'fa-instagram',
          scope: ''
        });
      }

      callback(null, strategies);
    });
  };

  Instagram.getAssociation = function(data, callback) {
    User.getUserFields(data.uid, ['instagramId', 'instagramUsername'], function(err, fields) {

      if (err) {
        return callback(err, data);
      }

      if (fields.instagramId) {
        data.associations.push({
          associated: true,
          url: 'https://www.instagram.com/' + fields.instagramUsername + '/',
          name: constants.name,
          icon: constants.admin.icon
        });
      } else {
        data.associations.push({
          associated: false,
          url: nconf.get('url') + '/auth/instagram',
          name: constants.name,
          icon: constants.admin.icon
        });
      }

      callback(null, data);
    })
  };

  Instagram.storeInfo = function(uid, accessToken, username) {
    winston.verbose("Storing instagram access information for uid(" + uid + ") accessToken(" + accessToken + ") username (" + username + ")");
    User.setUserField(uid, 'instagramAccessToken', accessToken);
    User.setUserField(uid, 'instagramUsername', username);
  };

  Instagram.login = function(instagramId, username, displayName, picture, website, accessToken, callback) {

    Instagram.getUidByInstagramId(instagramId, function(err, uid) {
      if(err) {
        return callback(err);
      }

      if (uid !== null) {
        // Existing User
        Instagram.storeInfo(uid, accessToken, username);

        callback(null, {
          uid: uid
        });
      } else {
        // New User
        var success = function(uid, merge) {
          // Auto verify users from instagram
          var autoConfirm = true;
          User.setUserField(uid, 'email:confirmed', autoConfirm);
          if (autoConfirm) {
            db.sortedSetRemove('users:notvalidated', uid);
          }
          
          // Save instagram-specific information to the user
          var data = {
            instagramId: instagramId,
          };

          if (!merge) {

            if (displayName && 0 < displayName.length) {
              data.fullname = displayName;
            }

            if (picture && 0 < picture.length) {
              data.uploadedpicture = picture;
              data.picture = picture;
            }

            if (website && 0 < website.length) {
              data.website = website;
            }
          }

          async.parallel([
            function(callback2) {
              Instagram.storeInfo(uid, accessToken, username);
              db.setObjectField('instagramId:uid', instagramId, uid, callback2);
            },
            function(callback2) {
              User.setUserFields(uid, data, callback2);
            }
          ], function(err, results) {
            if (err) {
              return callback(err);
            }

            callback(null, {
              uid: uid
            });
          });
        };

        // Create user with fake email because Instagram doesn't give it back to us.
        var fakeEmail = username + '@instagram.com';
        User.create({username: username, email: fakeEmail}, function(err, uid) {
          if(err) {
            return callback(err);
          }

          success(uid, false);
        });
      }
    });
  };

  Instagram.getUidByInstagramId = function(instagramId, callback) {
    db.getObjectField('instagramId:uid', instagramId, function(err, uid) {
      if (err) {
        return callback(err);
      }
      callback(null, uid);
    });
  };

  Instagram.addMenuItem = function(custom_header, callback) {
    custom_header.authentication.push({
      "route": constants.admin.route,
      "icon": constants.admin.icon,
      "name": constants.name
    });

    callback(null, custom_header);
  };

  Instagram.deleteUserData = function(data, callback) {

    async.waterfall([
      async.apply(User.getUserField, data.uid, 'instagramId'),
      function(instagramId, next) {
        db.deleteObjectField('instagramId:uid', instagramId, next);
      },
      function(next) {
        db.deleteObjectField('user:' + data.uid, 'instagramId', next);
      }
    ], function(err) {
      if (err) {
        winston.error('[sso-instagram] Could not remove OAuthId data for uid ' + data.uid + '. Error: ' + err);
        return callback(err);
      }
      callback(null, data.uid);
    });
  };

  module.exports = Instagram;
}(module));
