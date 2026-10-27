import "@everyos/app-ui/styles.css";
import "./todo.css";
import "./widget.css";
import { boot } from "@everyos/app-ui";
import { TaskWidget } from "./task-widget.tsx";

void boot(TaskWidget);
