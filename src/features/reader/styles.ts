// 阅读层样式表入口：只被 features/reader 的懒加载路径引用，
// 因此阅读层的 CSS 不进入三维入口的首屏产物。
import "./reader.css";
