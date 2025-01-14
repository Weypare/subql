// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApiPromise } from '@polkadot/api';
import { RpcMethodResult } from '@polkadot/api/types';
import { RuntimeVersion, Header } from '@polkadot/types/interfaces';
import {
  AnyFunction,
  DefinitionRpcExt,
  RegisteredTypes,
} from '@polkadot/types/types';
import { OverrideBundleDefinition } from '@polkadot/types/types/registry';
import {
  IndexerEvent,
  getLogger,
  NodeConfig,
  profilerWrap,
  ConnectionPoolService,
  ApiService as BaseApiService,
  IBlock,
  MetadataMismatchError,
} from '@subql/node-core';
import { SubstrateNodeConfig } from '../configure/NodeConfig';
import { SubqueryProject } from '../configure/SubqueryProject';
import { isOnlyEventHandlers } from '../utils/project';
import * as SubstrateUtil from '../utils/substrate';
import {
  ApiPromiseConnection,
  FetchFunc,
  GetFetchFunc,
} from './apiPromise.connection';
import { ApiAt, BlockContent, LightBlockContent } from './types';

const NOT_SUPPORT = (name: string) => () => {
  throw new Error(`${name}() is not supported`);
};

// https://github.com/polkadot-js/api/blob/12750bc83d8d7f01957896a80a7ba948ba3690b7/packages/rpc-provider/src/ws/index.ts#L43
const MAX_RECONNECT_ATTEMPTS = 5;

const logger = getLogger('api');

// This is a temp fix for https://github.com/polkadot-js/api/issues/5871
function overrideConsoleWarn(): void {
  (console as any).oldWarn = console.warn;
  console.warn = function () {
    // eslint-disable-next-line prefer-rest-params
    const args = Array.from(arguments);

    if (
      args.length > 0 &&
      args[0].includes('Unable to map [u8; 32] to a lookup index')
    ) {
      return;
    }
    (console as any).oldWarn.apply(console, args);
  };
}

async function dynamicImportHasher(
  methodName: string,
): Promise<(data: Uint8Array) => Uint8Array> {
  const module = await import('@polkadot/util-crypto');
  if (module[methodName]) {
    return module[methodName];
  } else {
    throw new Error(
      `Hasher Method ${methodName} not found in @polkadot/util-crypto`,
    );
  }
}

async function updateChainTypesHasher(
  chainTypes: any,
): Promise<RegisteredTypes | undefined> {
  if (!chainTypes) {
    return undefined;
  }
  if (chainTypes.hasher && typeof chainTypes.hasher === 'string') {
    logger.info(`Set overall spec hasher to ${chainTypes.hasher}`);
    chainTypes.hasher = await dynamicImportHasher(chainTypes.hasher);
  }
  const typesBundleSpecs: Record<string, OverrideBundleDefinition> =
    chainTypes.typesBundle.spec;
  if (typesBundleSpecs) {
    for (const [key, spec] of Object.entries(typesBundleSpecs)) {
      if (spec.hasher && typeof spec.hasher === 'string') {
        logger.info(`Set spec ${key} hasher to ${spec.hasher}`);
        spec.hasher = await dynamicImportHasher(spec.hasher);
      }
    }
  }
  return chainTypes;
}

@Injectable()
export class ApiService
  extends BaseApiService<
    ApiPromise,
    ApiAt,
    IBlock<BlockContent>[] | IBlock<LightBlockContent>[]
  >
  implements OnApplicationShutdown
{
  private fetchBlocksFunction: FetchFunc;
  private fetchBlocksBatches: GetFetchFunc = () => this.fetchBlocksFunction;
  private currentBlockHash: string;
  private currentBlockNumber: number;

  private nodeConfig: SubstrateNodeConfig;

  constructor(
    @Inject('ISubqueryProject') private project: SubqueryProject,
    connectionPoolService: ConnectionPoolService<ApiPromiseConnection>,
    eventEmitter: EventEmitter2,
    nodeConfig: NodeConfig,
  ) {
    super(connectionPoolService, eventEmitter);
    this.nodeConfig = new SubstrateNodeConfig(nodeConfig);

    this.updateBlockFetching();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.connectionPoolService.onApplicationShutdown();
  }

  async init(): Promise<ApiService> {
    overrideConsoleWarn();
    let chainTypes, network;
    try {
      chainTypes = await updateChainTypesHasher(this.project.chainTypes);
      network = this.project.network;

      if (this.nodeConfig.primaryNetworkEndpoint) {
        network.endpoint.push(this.nodeConfig.primaryNetworkEndpoint);
      }
    } catch (e) {
      logger.error(e);
      process.exit(1);
    }

    if (chainTypes) {
      logger.info('Using provided chain types');
    }

    await this.createConnections(
      network,
      //createConnection
      (endpoint) =>
        ApiPromiseConnection.create(endpoint, this.fetchBlocksBatches, {
          chainTypes,
        }),
      //postConnectedHook
      (connection: ApiPromiseConnection, endpoint: string, index: number) => {
        const api = connection.unsafeApi;
        api.on('connected', () => {
          this.eventEmitter.emit(IndexerEvent.ApiConnected, {
            value: 1,
            apiIndex: index,
            endpoint: endpoint,
          });
        });
        api.on('disconnected', () => {
          this.eventEmitter.emit(IndexerEvent.ApiConnected, {
            value: 0,
            apiIndex: index,
            endpoint: endpoint,
          });
        });
      },
    );

    return this;
  }

  updateBlockFetching(): void {
    const onlyEventHandlers = isOnlyEventHandlers(this.project);
    const skipTransactions =
      this.nodeConfig.skipTransactions && onlyEventHandlers;

    if (this.nodeConfig.skipTransactions) {
      if (onlyEventHandlers) {
        logger.info(
          'skipTransactions is enabled, only events and block headers will be fetched.',
        );
      } else {
        logger.info(
          `skipTransactions is disabled, the project contains handlers that aren't event handlers.`,
        );
      }
    } else {
      if (onlyEventHandlers) {
        logger.warn(
          'skipTransactions is disabled, the project contains only event handlers, it could be enabled to improve indexing performance.',
        );
      } else {
        logger.info(`skipTransactions is disabled.`);
      }
    }

    const fetchFunc = skipTransactions
      ? SubstrateUtil.fetchBlocksBatchesLight
      : SubstrateUtil.fetchBlocksBatches;

    if (this.nodeConfig?.profiler) {
      this.fetchBlocksFunction = profilerWrap(
        fetchFunc,
        'SubstrateUtil',
        'fetchBlocksBatches',
      );
    } else {
      this.fetchBlocksFunction = fetchFunc;
    }
  }

  get api(): ApiPromise {
    return this.unsafeApi;
  }

  async getPatchedApi(
    header: Header,
    runtimeVersion: RuntimeVersion,
  ): Promise<ApiAt> {
    this.currentBlockHash = header.hash.toString();
    this.currentBlockNumber = header.number.toNumber();

    const api = this.api;
    const apiAt = (await api.at(
      this.currentBlockHash,
      runtimeVersion,
    )) as ApiAt;
    this.patchApiRpc(api, apiAt);
    return apiAt;
  }

  private redecorateRpcFunction<T extends 'promise' | 'rxjs'>(
    original: RpcMethodResult<T, AnyFunction>,
  ): RpcMethodResult<T, AnyFunction> {
    const methodName = this.getRPCFunctionName(original);
    if (original.meta.params) {
      const hashIndex = original.meta.params.findIndex(
        ({ isHistoric }) => isHistoric,
      );
      if (hashIndex > -1) {
        const isBlockNumber =
          original.meta.params[hashIndex].type === 'BlockNumber';

        const ret = (async (...args: any[]) => {
          const argsClone = [...args];

          if (isBlockNumber) {
            if (argsClone[hashIndex] === undefined) {
              argsClone[hashIndex] = this.currentBlockNumber;
            } else if (argsClone[hashIndex] > this.currentBlockNumber) {
              throw new Error(
                `input block ${argsClone[hashIndex]} ahead of current block ${this.currentBlockNumber} is not supported`,
              );
            }
          }
          // is block hash
          else {
            if (argsClone[hashIndex] === undefined) {
              argsClone[hashIndex] = this.currentBlockHash;
            } else {
              const atBlock = await this.api.rpc.chain.getBlock(
                argsClone[hashIndex],
              );
              const atBlockNumber = atBlock.block.header.number.toNumber();
              if (atBlockNumber > this.currentBlockNumber) {
                throw new Error(
                  `input block hash ${argsClone[hashIndex]} ahead of current block ${this.currentBlockNumber} is not supported`,
                );
              }
            }
          }

          return original(...argsClone);
        }) as RpcMethodResult<T, AnyFunction>;
        ret.raw = NOT_SUPPORT(`${methodName}.raw`);
        ret.meta = original.meta;
        return ret;
      }
    }

    const ret = NOT_SUPPORT(methodName) as unknown as RpcMethodResult<
      T,
      AnyFunction
    >;
    ret.raw = NOT_SUPPORT(`${methodName}.raw`);
    ret.meta = original.meta;
    return ret;
  }

  private patchApiRpc(api: ApiPromise, apiAt: ApiAt): void {
    apiAt.rpc = Object.entries(api.rpc).reduce((acc, [module, rpcMethods]) => {
      acc[module] = Object.entries(rpcMethods).reduce(
        (accInner, [name, rpcPromiseResult]) => {
          accInner[name] = this.redecorateRpcFunction(
            rpcPromiseResult as RpcMethodResult<any, AnyFunction>,
          );
          return accInner;
        },
        {},
      );
      return acc;
    }, {} as ApiPromise['rpc']);
  }

  private getRPCFunctionName<T extends 'promise' | 'rxjs'>(
    original: RpcMethodResult<T, AnyFunction>,
  ): string {
    const ext = original.meta as unknown as DefinitionRpcExt;

    return `api.rpc.${ext?.section ?? '*'}.${ext?.method ?? '*'}`;
  }

  // Overrides the super function because of the specVer
  async fetchBlocks(
    heights: number[],
    overallSpecVer?: number,
    numAttempts = MAX_RECONNECT_ATTEMPTS,
  ): Promise<IBlock<LightBlockContent>[]> {
    return this.retryFetch(async () => {
      // Get the latest fetch function from the provider
      const apiInstance = this.connectionPoolService.api;
      return apiInstance.fetchBlocks(heights, overallSpecVer);
    }, numAttempts);
  }

  // Polkadot uses genesis hash instead of chainId
  protected assertChainId(
    network: { chainId: string },
    connection: ApiPromiseConnection,
  ): void {
    if (network.chainId !== connection.networkMeta.genesisHash) {
      throw new MetadataMismatchError(
        'ChainId',
        network.chainId,
        connection.networkMeta.genesisHash,
      );
    }
  }
}
