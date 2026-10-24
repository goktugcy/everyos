import "@everyos/app-ui/styles.css";
import "./pomodoro.css";
import "./widget.css";
import { boot } from "@everyos/app-ui";
import { TimerWidget } from "./timer-widget.tsx";

void boot(TimerWidget);
