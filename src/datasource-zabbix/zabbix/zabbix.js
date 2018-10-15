import _ from 'lodash';
import * as utils from '../utils';
import responseHandler from '../responseHandler';
import { ZabbixAPIConnector } from './connectors/zabbix_api/zabbixAPIConnector';
import { SQLConnector } from './connectors/sql/sqlConnector';
import { CachingProxy } from './proxy/cachingProxy';
import { ZabbixNotImplemented } from './connectors/dbConnector';

const REQUESTS_TO_PROXYFY = [
  'getHistory', 'getTrend', 'getGroups', 'getHosts', 'getApps', 'getItems', 'getMacros', 'getItemsByIDs',
  'getEvents', 'getAlerts', 'getHostAlerts', 'getAcknowledges', 'getITService', 'getSLA', 'getVersion'
];

const REQUESTS_TO_CACHE = [
  'getGroups', 'getHosts', 'getApps', 'getItems', 'getMacros', 'getItemsByIDs', 'getITService'
];

const REQUESTS_TO_BIND = [
  'getHistory', 'getTrend', 'getMacros', 'getItemsByIDs', 'getEvents', 'getAlerts', 'getHostAlerts',
  'getAcknowledges', 'getITService', 'getVersion', 'login'
];

export class Zabbix {
  constructor(options, backendSrv, datasourceSrv) {
    let {
      url,
      username,
      password,
      basicAuth,
      withCredentials,
      cacheTTL,
      enableDirectDBConnection,
      dbConnectionDatasourceId,
      dbConnectionDatasourceName,
    } = options;

    this.enableDirectDBConnection = enableDirectDBConnection;

    // Initialize caching proxy for requests
    let cacheOptions = {
      enabled: true,
      ttl: cacheTTL
    };
    this.cachingProxy = new CachingProxy(cacheOptions);

    this.zabbixAPI = new ZabbixAPIConnector(url, username, password, basicAuth, withCredentials, backendSrv);

    if (enableDirectDBConnection) {
      let dbConnectorOptions = {
        datasourceId: dbConnectionDatasourceId,
        datasourceName: dbConnectionDatasourceName
      };
      this.dbConnector = new SQLConnector(dbConnectorOptions, backendSrv, datasourceSrv);
      this.getHistoryDB = this.cachingProxy.proxyfyWithCache(this.dbConnector.getHistory, 'getHistory', this.dbConnector);
      this.getTrendsDB = this.cachingProxy.proxyfyWithCache(this.dbConnector.getTrends, 'getTrends', this.dbConnector);
    }

    this.proxyfyRequests();
    this.cacheRequests();
    this.bindRequests();
  }

  proxyfyRequests() {
    for (let request of REQUESTS_TO_PROXYFY) {
      this.zabbixAPI[request] = this.cachingProxy.proxyfy(this.zabbixAPI[request], request, this.zabbixAPI);
    }
  }

  cacheRequests() {
    for (let request of REQUESTS_TO_CACHE) {
      this.zabbixAPI[request] = this.cachingProxy.cacheRequest(this.zabbixAPI[request], request, this.zabbixAPI);
    }
  }

  bindRequests() {
    for (let request of REQUESTS_TO_BIND) {
      this[request] = this.zabbixAPI[request].bind(this.zabbixAPI);
    }
  }

  /**
   * Perform test query for Zabbix API and external history DB.
   * @return {object} test result object:
   * ```
    {
      zabbixVersion,
      dbConnectorStatus: {
        dsType,
        dsName
      }
    }
   ```
   */
  testDataSource() {
    let zabbixVersion;
    let dbConnectorStatus;
    return this.getVersion()
    .then(version => {
      zabbixVersion = version;
      return this.login();
    })
    .then(() => {
      if (this.enableDirectDBConnection) {
        return this.dbConnector.testDataSource();
      } else {
        return Promise.resolve();
      }
    })
    .catch(error => {
      if (error instanceof ZabbixNotImplemented) {
        return Promise.resolve();
      }
      return Promise.reject(error);
    })
    .then(testResult => {
      if (testResult) {
        dbConnectorStatus = {
          dsType: this.dbConnector.datasourceTypeName,
          dsName: this.dbConnector.datasourceName
        };
      }
      return { zabbixVersion, dbConnectorStatus };
    });
  }

  getItemsFromTarget(target, options) {
    let parts = ['group', 'host', 'application', 'item'];
    let filters = _.map(parts, p => target[p].filter);
    return this.getItems(...filters, options);
  }

  getHostsFromTarget(target) {
    let parts = ['group', 'host', 'application'];
    let filters = _.map(parts, p => target[p].filter);
    return Promise.all([
      this.getHosts(...filters),
      this.getApps(...filters),
    ]).then((results) => {
      let [hosts, apps] = results;
      if (apps.appFilterEmpty) {
        apps = [];
      }
      return [hosts, apps];
    });
  }

  getAllGroups() {
    return this.zabbixAPI.getGroups();
  }

  getGroups(groupFilter) {
    return this.getAllGroups()
    .then(hstgrp => findByFilter(hstgrp, groupFilter));
  }

  /**
   * Get list of host belonging to given groups.
   */
  getAllHosts(groupFilter) {
    return this.getGroups(groupFilter)
    .then(hstgrp => {
      let groupids = _.map(hstgrp, 'groupid');
      return this.zabbixAPI.getHosts(groupids);
    });
  }

  getHosts(groupFilter, hostFilter) {
    return this.getAllHosts(groupFilter)
    .then(hosts => findByFilter(hosts, hostFilter));
  }

  /**
   * Get list of applications belonging to given groups and hosts.
   */
  getAllApps(groupFilter, hostFilter) {
    return this.getHosts(groupFilter, hostFilter)
    .then(hosts => {
      let hostids = _.map(hosts, 'hostid');
      return this.zabbixAPI.getApps(hostids);
    });
  }

  getApps(groupFilter, hostFilter, appFilter) {
    return this.getHosts(groupFilter, hostFilter)
    .then(hosts => {
      let hostids = _.map(hosts, 'hostid');
      if (appFilter) {
        return this.zabbixAPI.getApps(hostids)
        .then(apps => filterByQuery(apps, appFilter));
      } else {
        return {
          appFilterEmpty: true,
          hostids: hostids
        };
      }
    });
  }

  getAllItems(groupFilter, hostFilter, appFilter, options = {}) {
    return this.getApps(groupFilter, hostFilter, appFilter)
    .then(apps => {
      if (apps.appFilterEmpty) {
        return this.zabbixAPI.getItems(apps.hostids, undefined, options.itemtype);
      } else {
        let appids = _.map(apps, 'applicationid');
        return this.zabbixAPI.getItems(undefined, appids, options.itemtype);
      }
    })
    .then(items => {
      if (!options.showDisabledItems) {
        items = _.filter(items, {'status': '0'});
      }

      return items;
    })
    .then(this.expandUserMacro.bind(this));
  }

  expandUserMacro(items) {
    let hostids = getHostIds(items);
    return this.getMacros(hostids)
    .then(macros => {
      _.forEach(items, item => {
        if (utils.containsMacro(item.name)) {
          item.name = utils.replaceMacro(item, macros);
        }
      });
      return items;
    });
  }

  getItems(groupFilter, hostFilter, appFilter, itemFilter, options = {}) {
    return this.getAllItems(groupFilter, hostFilter, appFilter, options)
    .then(items => filterByQuery(items, itemFilter));
  }

  getITServices(itServiceFilter) {
    return this.zabbixAPI.getITService()
    .then(itServices => findByFilter(itServices, itServiceFilter));
  }

  /**
   * Build query - convert target filters to array of Zabbix items
   */
  getTriggers(groupFilter, hostFilter, appFilter, options) {
    let promises = [
      this.getGroups(groupFilter),
      this.getHosts(groupFilter, hostFilter),
      this.getApps(groupFilter, hostFilter, appFilter)
    ];

    return Promise.all(promises)
    .then(results => {
      let filteredGroups = results[0];
      let filteredHosts = results[1];
      let filteredApps = results[2];
      let query = {};

      if (appFilter) {
        query.applicationids = _.flatten(_.map(filteredApps, 'applicationid'));
      }
      if (hostFilter) {
        query.hostids = _.map(filteredHosts, 'hostid');
      }
      if (groupFilter) {
        query.groupids = _.map(filteredGroups, 'groupid');
      }

      return query;
    }).then(query => {
      return this.zabbixAPI.getTriggers(query.groupids, query.hostids, query.applicationids, options);
    });
  }

  getHistoryTS(items, timeRange, options) {
    let [timeFrom, timeTo] = timeRange;
    if (this.enableDirectDBConnection) {
      return this.getHistoryDB(items, timeFrom, timeTo, options)
      .then(history => this.dbConnector.handleGrafanaTSResponse(history, items));
    } else {
      return this.zabbixAPI.getHistory(items, timeFrom, timeTo)
      .then(history => responseHandler.handleHistory(history, items));
    }
  }

  getTrends(items, timeRange, options) {
    let [timeFrom, timeTo] = timeRange;
    if (this.enableDirectDBConnection) {
      return this.getTrendsDB(items, timeFrom, timeTo, options)
      .then(history => this.dbConnector.handleGrafanaTSResponse(history, items));
    } else {
      let valueType = options.consolidateBy || options.valueType;
      return this.zabbixAPI.getTrend(items, timeFrom, timeTo)
      .then(history => responseHandler.handleTrends(history, items, valueType))
      .then(responseHandler.sortTimeseries); // Sort trend data, issue #202
    }
  }

  getHistoryText(items, timeRange, target) {
    let [timeFrom, timeTo] = timeRange;
    if (items.length) {
      return this.zabbixAPI.getHistory(items, timeFrom, timeTo)
      .then(history => {
        if (target.resultFormat === 'table') {
          return responseHandler.handleHistoryAsTable(history, items, target);
        } else {
          return responseHandler.handleText(history, items, target);
        }
      });
    } else {
      return Promise.resolve([]);
    }
  }

  getSLA(itservices, timeRange, target, options) {
    let itServices = itservices;
    if (options.isOldVersion) {
      itServices = _.filter(itServices, {'serviceid': target.itservice.serviceid});
    }
    let itServiceIds = _.map(itServices, 'serviceid');
    return this.zabbixAPI.getSLA(itServiceIds, timeRange)
    .then(slaResponse => {
      return _.map(itServiceIds, serviceid => {
        let itservice = _.find(itServices, {'serviceid': serviceid});
        return responseHandler.handleSLAResponse(itservice, target.slaProperty, slaResponse);
      });
    });
  }
}

///////////////////////////////////////////////////////////////////////////////

/**
 * Find group, host, app or item by given name.
 * @param  list list of groups, apps or other
 * @param  name visible name
 * @return      array with finded element or empty array
 */
function findByName(list, name) {
  var finded = _.find(list, {'name': name});
  if (finded) {
    return [finded];
  } else {
    return [];
  }
}

/**
 * Different hosts can contains applications and items with same name.
 * For this reason use _.filter, which return all elements instead _.find,
 * which return only first finded.
 * @param  {[type]} list list of elements
 * @param  {[type]} name app name
 * @return {[type]}      array with finded element or empty array
 */
function filterByName(list, name) {
  var finded = _.filter(list, {'name': name});
  if (finded) {
    return finded;
  } else {
    return [];
  }
}

function filterByRegex(list, regex) {
  var filterPattern = utils.buildRegex(regex);
  return _.filter(list, function (zbx_obj) {
    return filterPattern.test(zbx_obj.name);
  });
}

function findByFilter(list, filter) {
  if (utils.isRegex(filter)) {
    return filterByRegex(list, filter);
  } else {
    return findByName(list, filter);
  }
}

function filterByQuery(list, filter) {
  if (utils.isRegex(filter)) {
    return filterByRegex(list, filter);
  } else {
    return filterByName(list, filter);
  }
}

function getHostIds(items) {
  let hostIds = _.map(items, item => {
    return _.map(item.hosts, 'hostid');
  });
  return _.uniq(_.flatten(hostIds));
}
