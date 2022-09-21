import createDebug from 'debug';
import persist from 'node-persist';
import DiscordRPC from 'discord-rpc';
import { Game } from '../../../api/coral-types.js';
import { BankaraMatchMode, FriendListResult, FriendOnlineState, GraphQLResponse, StageScheduleResult } from '../../../api/splatnet3-types.js';
import SplatNet3Api from '../../../api/splatnet3.js';
import { DiscordPresenceExternalMonitorsConfiguration } from '../../../app/common/types.js';
import { Arguments } from '../../../cli/nso/presence.js';
import { getBulletToken, SavedBulletToken } from '../../../common/auth/splatnet3.js';
import { ExternalMonitorPresenceInterface } from '../../../common/presence.js';
import { EmbeddedLoop, LoopResult } from '../../../util/loop.js';
import { ArgumentsCamelCase } from '../../../util/yargs.js';
import { DiscordPresenceContext, ErrorResult } from '../../types.js';
import { product } from '../../../util/product.js';

const debug = createDebug('nxapi:discord:splatnet3');

export default class SplatNet3Monitor extends EmbeddedLoop {
    update_interval: number = 1 * 60; // 1 minute in seconds

    splatnet: SplatNet3Api | null = null;
    data: SavedBulletToken | null = null;

    cached_friends: GraphQLResponse<FriendListResult> | null = null;
    cached_schedules: GraphQLResponse<StageScheduleResult> | null = null;

    friend: FriendListResult['friends']['nodes'][0] | null = null;

    regular_schedule: StageScheduleResult['regularSchedules']['nodes'][0] | null = null;
    anarchy_schedule: StageScheduleResult['bankaraSchedules']['nodes'][0] | null = null;
    fest_schedule: StageScheduleResult['festSchedules']['nodes'][0] | null = null;
    league_schedule: StageScheduleResult['leagueSchedules']['nodes'][0] | null = null;
    x_schedule: StageScheduleResult['xSchedules']['nodes'][0] | null = null;
    coop_schedule: StageScheduleResult['coopGroupingSchedule']['regularSchedules']['nodes'][0] | null = null;

    constructor(
        readonly discord_presence: ExternalMonitorPresenceInterface,
        protected config: SplatNet3MonitorConfig | null,
    ) {
        super();
    }

    onUpdateConfig(config: SplatNet3MonitorConfig | null) {
        if (!!config !== !!this.config) return false;

        if (config?.storage !== this.config?.storage) return false;
        if (config?.na_session_token !== this.config?.na_session_token) return false;
        if (config?.znc_proxy_url !== this.config?.znc_proxy_url) return false;
        if (config?.allow_fetch_token !== this.config?.allow_fetch_token) return false;

        this.config = config;
        this.skipIntervalInCurrentLoop();

        return true;
    }

    get friend_nsaid() {
        return this.config?.friend_nsaid ?? this.discord_presence.znc_discord_presence.presence_user;
    }

    async init(): Promise<void> {
        if (!this.config) {
            debug('Not enabling SplatNet 3 monitor - not configured');
            return this.disable();
        }

        debug('Started monitor');

        try {
            const {splatnet, data} = await getBulletToken(
                this.config.storage,
                this.config.na_session_token,
                this.config.znc_proxy_url,
                this.config.allow_fetch_token,
            );

            this.splatnet = splatnet;
            this.data = data;
        } catch (err) {
            const result = await this.discord_presence.handleError(err as Error);
            if (result === ErrorResult.RETRY) return this.init();
            if (result === ErrorResult.STOP) return this.disable();
        }

        const history = await this.splatnet!.getHistoryRecords();
        await this.splatnet!.getConfigureAnalytics();
        await this.splatnet!.getCurrentFest();

        debug('Authenticated to SplatNet 3 %s - player %s#%s (title %s, first played %s)', this.data!.version,
            history.data.currentPlayer.name,
            history.data.currentPlayer.nameId,
            history.data.currentPlayer.byname,
            new Date(history.data.playHistory.gameStartTime).toLocaleString());

        this.cached_friends = await this.splatnet!.getFriends();
        this.cached_schedules = await this.splatnet!.getSchedules();
    }

    async update() {
        const friends = this.cached_friends ?? await this.splatnet?.getFriendsRefetch();
        this.cached_friends = null;

        const friend_id = Buffer.from('Friend-' + this.friend_nsaid).toString('base64');
        const friend = friends?.data.friends.nodes.find(f => f.id === friend_id) ?? null;

        this.friend = friend;

        this.regular_schedule = this.getSchedule(this.cached_schedules?.data.regularSchedules.nodes ?? []);

        if (!this.regular_schedule) {
            this.cached_schedules = await this.splatnet!.getSchedules();
            this.regular_schedule = this.getSchedule(this.cached_schedules?.data.regularSchedules.nodes ?? []);
        }

        this.anarchy_schedule = this.getSchedule(this.cached_schedules?.data.bankaraSchedules.nodes ?? []);
        this.fest_schedule = this.getSchedule(this.cached_schedules?.data.festSchedules.nodes ?? []);
        this.league_schedule = this.getSchedule(this.cached_schedules?.data.leagueSchedules.nodes ?? []);
        this.x_schedule = this.getSchedule(this.cached_schedules?.data.xSchedules.nodes ?? []);
        this.coop_schedule = this.getSchedule(this.cached_schedules?.data.coopGroupingSchedule.regularSchedules.nodes ?? []);

        this.discord_presence.refreshPresence();
    }

    getSchedule<T extends {startTime: string; endTime: string;}>(schedules: T[]): T | null {
        const now = Date.now();

        for (const schedule of schedules) {
            const start = new Date(schedule.startTime);
            const end = new Date(schedule.endTime);

            if (start.getTime() >= now) continue;
            if (end.getTime() < now) continue;

            return schedule;
        }

        return null;
    }

    async handleError(err: Error) {
        const result = await this.discord_presence.handleError(err as Error);
        if (result === ErrorResult.RETRY) return LoopResult.OK_SKIP_INTERVAL;

        this.friend = null;
        this.discord_presence.refreshPresence();

        if (result === ErrorResult.STOP) this.disable();
        return LoopResult.OK;
    }
}

export interface SplatNet3MonitorConfig {
    storage: persist.LocalStorage;
    na_session_token: string;
    znc_proxy_url?: string;
    allow_fetch_token: boolean;
    friend_nsaid?: string;
}

export function getConfigFromArgv(
    argv: ArgumentsCamelCase<Arguments>,
    storage: persist.LocalStorage,
    na_session_token: string,
): SplatNet3MonitorConfig | null {
    if (!argv.splatnet3Monitor) return null;

    return {
        storage,
        na_session_token,
        znc_proxy_url: argv.zncProxyUrl,
        allow_fetch_token: argv.splatnet3AutoUpdateSession,
    };
}

export function getConfigFromAppConfig(
    config: DiscordPresenceExternalMonitorsConfiguration,
    storage: persist.LocalStorage,
    na_session_token: string,
): SplatNet3MonitorConfig | null {
    if (!config.enable_splatnet3_monitoring) return null;

    return {
        storage,
        na_session_token,
        znc_proxy_url: process.env.ZNC_PROXY_URL,
        allow_fetch_token: true,
    };
}

export function callback(activity: DiscordRPC.Presence, game: Game, context?: DiscordPresenceContext) {
    const monitor = context?.monitors?.find(m => m instanceof SplatNet3Monitor) as SplatNet3Monitor | undefined;
    if (!monitor?.friend) return;

    // REGULAR, BANKARA, X_MATCH, LEAGUE, PRIVATE, FEST
    const mode_image =
        monitor.friend.vsMode?.mode === 'REGULAR' ? 'mode-regular-1' :
        monitor.friend.vsMode?.mode === 'BANKARA' ? 'mode-anarchy-1' :
        monitor.friend.vsMode?.mode === 'FEST' ? 'mode-fest-1' :
        monitor.friend.vsMode?.mode === 'LEAGUE' ? 'mode-league-1' :
        monitor.friend.vsMode?.mode === 'X_MATCH' ? 'mode-x-1' :
        undefined;

    const mode_name =
        monitor.friend.vsMode?.mode === 'REGULAR' ? 'Regular Battle' :
        monitor.friend.vsMode?.id === 'VnNNb2RlLTI=' ? 'Anarchy Battle (Series)' : // VsMode-2
        monitor.friend.vsMode?.id === 'VnNNb2RlLTUx' ? 'Anarchy Battle (Open)' : // VsMode-51
        monitor.friend.vsMode?.mode === 'BANKARA' ? 'Anarchy Battle' :
        monitor.friend.vsMode?.mode === 'FEST' ? 'Splatfest Battle' :
        monitor.friend.vsMode?.mode === 'LEAGUE' ? 'League Battle' :
        monitor.friend.vsMode?.mode === 'X_MATCH' ? 'X Battle' :
        undefined;

    const schedule_setting =
        monitor.friend.vsMode?.mode === 'REGULAR' ? monitor.regular_schedule?.regularMatchSetting :
        monitor.friend.vsMode?.mode === 'BANKARA' ?
            monitor.friend.vsMode.id === 'VnNNb2RlLTI=' ?
                monitor.anarchy_schedule?.bankaraMatchSettings.find(s => s.mode === BankaraMatchMode.CHALLENGE) :
            monitor.friend.vsMode.id === 'VnNNb2RlLTUx' ?
                monitor.anarchy_schedule?.bankaraMatchSettings.find(s => s.mode === BankaraMatchMode.OPEN) :
            null :
        monitor.friend.vsMode?.mode === 'FEST' ? monitor.regular_schedule?.regularMatchSetting :
        monitor.friend.vsMode?.mode === 'LEAGUE' ? monitor.league_schedule?.leagueMatchSetting :
        monitor.friend.vsMode?.mode === 'X_MATCH' ? monitor.x_schedule?.xMatchSetting :
        null;

    if ((monitor.friend.onlineState === FriendOnlineState.VS_MODE_MATCHING ||
        monitor.friend.onlineState === FriendOnlineState.VS_MODE_FIGHTING) && monitor.friend.vsMode
    ) {
        activity.details =
            (mode_name ?? monitor.friend.vsMode.name) +
            (schedule_setting ? ' - ' + schedule_setting.vsRule.name : '') +
            (monitor.friend.onlineState === FriendOnlineState.VS_MODE_MATCHING ? ' (matching)' : '');

        if (schedule_setting) {
            activity.largeImageKey = 'https://fancy.org.uk/api/nxapi/s3/image?' + new URLSearchParams({
                a: schedule_setting.vsStages[0].id,
                b: schedule_setting.vsStages[1].id,
                v: '2022092104',
            }).toString();
            activity.largeImageText = schedule_setting.vsStages.map(s => s.name).join('/') +
                ' | ' + product;
        }

        activity.smallImageKey = mode_image;
        activity.smallImageText = mode_name ?? monitor.friend.vsMode.name;
    }

    if (monitor.friend.onlineState === FriendOnlineState.COOP_MODE_MATCHING ||
        monitor.friend.onlineState === FriendOnlineState.COOP_MODE_FIGHTING
    ) {
        activity.details = 'Salmon Run' +
            (monitor.friend.onlineState === FriendOnlineState.COOP_MODE_MATCHING ? ' (matching)' : '');

        if (monitor.coop_schedule) {
            const coop_stage_image = new URL(monitor.coop_schedule.setting.coopStage.image.url);
            const match = coop_stage_image.pathname.match(/^\/resources\/prod\/(.+)$/);
            const proxy_stage_image = match ? 'https://splatoon3.ink/assets/splatnet/' + match[1] : null;

            if (proxy_stage_image) {
                activity.largeImageKey = proxy_stage_image;
                activity.largeImageText = monitor.coop_schedule.setting.coopStage.name +
                    ' | ' + product;
            }
        }
    }
}