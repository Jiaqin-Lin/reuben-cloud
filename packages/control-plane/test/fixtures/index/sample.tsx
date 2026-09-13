/** fixture：TSX——同一个语法文件里 type 与 JSX 并存，`<Panel />` 里的名字不该被当成调用。 */

export interface PanelProps {
  title: string;
  count?: number;
}

export function Panel({ title, count = 1 }: PanelProps) {
  return <h1>{`${title} x${count}`}</h1>;
}

export class PanelView extends Component<PanelProps> {
  render() {
    return <Panel title={this.props.title} />;
  }
}
