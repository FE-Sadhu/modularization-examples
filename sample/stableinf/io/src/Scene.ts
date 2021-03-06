import { ActiveRecord, ActiveRecordClass, getTableName } from './ActiveRecord';
import type { MethodsOf } from './MethodsOf';
import type { GatewayClass } from './Gateway';
import { uuid } from './uuid';

type OmitFirstArg<F> = F extends (x: any, ...args: infer P) => infer R ? (...args: P) => R : never;

// 提供对各种 ActiveRecord 的增删改查，适配各种类型的关系数据库
export interface Database {
    insert(
        scene: Scene,
        activeRecordClass: ActiveRecordClass,
        props: Record<string, any>,
    ): Promise<ActiveRecord>;
    update<T extends ActiveRecord>(scene: Scene, activeRecord: T): Promise<void>;
    delete<T extends ActiveRecord>(scene: Scene, activeRecord: T): Promise<void>;
    // 只支持 = 和 AND
    queryByExample<T extends ActiveRecord>(
        scene: Scene,
        activeRecordClass: ActiveRecordClass<T>,
        props: Partial<T>,
    ): Promise<T[]>;
    // 执行任意 SQL
    executeSql(
        scene: Scene,
        sql: string,
        sqlVars: Record<string, any>,
        optoins?: {
            read?: ActiveRecordClass[];
            write?: ActiveRecordClass[];
        },
    ): Promise<any[]>;
}

// 提供远程方法调用
export interface ServiceProtocol {
    call(scene: Scene, project: string, service: string, args: any[]): Promise<any>;
}

// trace -> operation -> scene
// 一个 trace 会有多个进程被多次执行，每次执行是一个 operation（或者叫span）
// 一个 operation 会包含一个或者多个 scene
// 浏览器进入首次渲染，是一个 operation
// 每次鼠标点击，触发重渲染，也是一个 operation。此时因为可能触发多处重渲染，所以会触发多个 scene
// 后端 handle 一个 http 请求也是一个 operation（但是和前端的 operation 共享 trace 信息）
export interface Operation {
    // traceId, traceOp, baggage 会 RPC 透传
    traceId: string;
    parentSpanId?: string;
    spanId: string;
    traceOp: string;
    baggage: Record<string, any>;
    // 以下字段仅在进程内，不会 RPC 透传
    props: Record<string, any>;
    onError?: (e: any) => void;
    onAsyncTaskStarted?: (task: Promise<any>) => Promise<any>;
}

export function newOperation(traceOp: string): Operation {
    // 分布式追踪的 traceId 是在前端浏览器这里分配的，一直会往后传递
    return {
        traceId: uuid(),
        spanId: uuid(),
        traceOp,
        baggage: {},
        props: {},
    };
}

export interface SceneConf {
    serviceProtocol: ServiceProtocol;
    database: Database;
}

// 同时每个异步执行流程会创建一个独立的 scene，用来跟踪异步操作与I/O的订阅关系
// 后端 handle 一个 http 请求，后端不开启订阅
// 前端计算每个 future 的值（读操作），捕捉订阅关系
// 前端处理一次鼠标点击（写操作），触发订阅者
export class Scene {
    public static currentProject = '';
    public notifyChange = (tableName: string) => {};
    // operation 在 scene 的整个声明周期内是不变的
    public readonly operation: Operation;
    public readonly database: Database;
    public readonly serviceProtocol: ServiceProtocol;
    public readonly subscribers = new Set<{
        subscribe(tableName: string): void;
    }>();
    constructor(options: {
        database: Database;
        serviceProtocol: ServiceProtocol;
        operation: Operation;
    }) {
        Object.assign(this, options);
    }

    public subscribe(tableName: string) {
        for (const subscriber of this.subscribers) {
            subscriber.subscribe(tableName);
        }
    }

    public useServices<T extends GatewayClass | ActiveRecordClass>(
        project?: string,
    ): {
        [P in MethodsOf<T>]: (...a: Parameters<OmitFirstArg<T[P]>>) => ReturnType<T[P]>;
    } {
        const scene = this;
        // proxy intercept property get, returns rpc stub
        const get = (target: object, propertyKey: string, receiver?: any) => {
            return (...args: any[]) => {
                return scene.serviceProtocol.call(
                    scene,
                    project || Scene.currentProject,
                    propertyKey,
                    args,
                );
            };
        };
        return new Proxy({}, { get }) as any;
    }

    public insert<T extends ActiveRecord>(
        activeRecordClass: ActiveRecordClass<T>,
        props: Partial<T>,
    ): Promise<T> {
        return this.database.insert(this, activeRecordClass, props) as any;
    }
    public update: OmitFirstArg<Database['update']> = (activeRecord) => {
        return this.database.update(this, activeRecord);
    };
    public delete: OmitFirstArg<Database['delete']> = (activeRecord) => {
        return this.database.delete(this, activeRecord);
    };
    public executeSql: OmitFirstArg<Database['executeSql']> = (sql, sqlVars) => {
        return this.database.executeSql(this, sql, sqlVars);
    };
    public query<T extends ActiveRecord>(
        activeRecordClass: ActiveRecordClass<T>,
        props: Partial<T>,
    ): Promise<T[]>;
    public query<T extends ActiveRecord, P>(
        sqlView: (scene: Scene, sqlVars: P) => Promise<T[]>,
        sqlVars: P,
    ): Promise<T[]>;
    public query<T extends ActiveRecord>(
        sqlView: (scene: Scene, sqlVars: {}) => Promise<T[]>,
    ): Promise<T[]>;
    public query(arg1: any, arg2?: any) {
        if (arg1.IS_ACTIVE_RECORD) {
            return this.database.queryByExample(this, arg1, arg2);
        }
        return arg1(this, arg2);
    }
    public async load<T extends ActiveRecord>(
        activeRecordClass: ActiveRecordClass<T>,
        props: Partial<T>,
    ): Promise<T> {
        const records = await this.query(activeRecordClass, props);
        if (records.length === 0) {
            throw new Error(
                `${getTableName(activeRecordClass)} is empty, can not find ${JSON.stringify(
                    props,
                )}`,
            );
        }
        if (records.length !== 1) {
            throw new Error(
                `${getTableName(activeRecordClass)} find more than 1 match of ${JSON.stringify(
                    props,
                )}`,
            );
        }
        return records[0];
    }
    public async get<T extends ActiveRecord>(
        activeRecordClass: ActiveRecordClass<T>,
        id?: any,
    ): Promise<T> {
        return await this.load(activeRecordClass, id ? { id } : ({} as any));
    }
    public async sleep(millis: number) {
        return new Promise((resolve) => setTimeout(resolve, millis));
    }
    public toJSON() {
        return undefined;
    }
    get [Symbol.toStringTag]() {
        return `[OP]${this.operation.traceId} ${this.operation.traceOp}`;
    }
}
