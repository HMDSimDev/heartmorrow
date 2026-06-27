import { createRoot } from 'react-dom/client';
import { QuestEditor } from './components/wayfarer/QuestEditor';
import './styles.css';
import './pages/wayfarer.page.css';
const draft = { id:'q1', name:'X', blurb:'', partnerId:null, minWarmthBand:0, graph:{ entryNodeId:'b', maxTurns:8, timeoutOutcome:'resolved', nodes:[{ id:'b', kind:'scene', setup:'', entities:[{id:'pip',name:'Pip',description:'young barista',faction:'neutral',disposition:10,hp:undefined},{id:'box',name:'Strongbox',description:'rusted shut',faction:'hostile',disposition:0,hp:20}], affordances:[{verb:'persuade',stat:'charm',difficulty:'normal',hint:'',effects:{success:[],partial:[],fail:[],complication:[]}}], edges:[], isTerminal:false }], goals:[{id:'w',kind:'flag',outcome:'win',label:'d',predicate:{kind:'flag',flag:'x'}}] } };
createRoot(document.getElementById('root')!).render(<div className="wf" style={{padding:20}}><QuestEditor worldId="w1" draft={draft as any} onClose={()=>{}} onSaved={()=>{}} /></div>);
