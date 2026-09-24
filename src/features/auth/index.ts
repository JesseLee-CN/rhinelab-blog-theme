/**
 * 启动身份门与登录/注册：功能模块的唯一对外入口。
 *
 * 该模块是首屏关键路径的一部分（序幕要在初次绘制前遮挡舞台，LOGIN-IMPROVE
 * L1b），因此它的样式表随本入口静态引入，与阅读层“按需加载”的策略不同。
 * 移除该功能 = 删除本目录 + src/main.ts 中的 createEntryFeature 装配块。
 */
import "./panel.css";
import "./intro.css";

export { createEntryFeature } from "./entry";
export type { EntryFeature, EntryHost, EntryReviewSnapshot, StageRect } from "./entry";
export { HANDOFF_APP_TIME } from "./intro-motion";
export type { BootIdentity, ChosenIdentity } from "../../../shared/auth/identity";
export type { EntryPanelPhase, IntroPhase } from "./identity";
