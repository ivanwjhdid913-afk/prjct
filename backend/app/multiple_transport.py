"""Conservative point inflows on a complete 1D reach, with bounded resources.

Independent model v2: legacy transport.py remains the reproducible v1 solver.
Point inflows lie exactly on finite-volume faces. Their water and solute fluxes
are coupled through a continuous face concentration, rather than adding full
concentration fields. Cell means are stored as excess kg/m³ above background.
"""
import math
import re
import time
from array import array
from collections.abc import Callable
from app.transport import (PARAMETER_LIMITS, validate_parameters, _compress_trajectory,
    _resolution_limit, _event_neighbor_hour, _profile_steps, MAX_CELLS, MAX_STEPS,
    MAX_UPDATES, MAX_OUTPUT_STATES, MAX_REFERENCE_BYTES, MAX_RESPONSE_BYTES,
    INTERPOLATION_RELATIVE_TOLERANCE, INTERPOLATION_ABSOLUTE_TOLERANCE_MG_L)

MULTIPLE_MODEL_ID = 'conservative-1d-lateral-inflow-v2'
MULTIPLE_FORMAT_VERSION = 3
SHARED = ('river_flow_m3_s', 'background_mg_l', 'velocity_m_s', 'dispersion_m2_s', 'length_m', 'duration_hours')
SOURCE_FIELDS = {'id','name','source_distance_m','effluent_flow_m3_s','effluent_mg_l','load_mode','load_duration_hours','load_intervals'}


def validate_sources(params: dict) -> dict:
    if not isinstance(params, dict) or set(params) != {*SHARED, 'sources'}:
        raise ValueError('Нужны общие параметры полного участка и явный список sources.')
    p = {}
    for key in SHARED:
        low, high = PARAMETER_LIMITS[key]
        v = params[key]
        if isinstance(v, bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not low <= v <= high:
            raise ValueError(f'{key}: требуется конечное число от {low:g} до {high:g}.')
        p[key] = float(v)
    if not isinstance(params['sources'], list) or not 1 <= len(params['sources']) <= 3:
        raise ValueError('Нужен список от одного до трёх сценарных источников.')
    ids, sources = set(), []
    for i, source in enumerate(params['sources']):
        prefix = f'sources[{i}]'
        if not isinstance(source,dict) or set(source) != SOURCE_FIELDS:
            raise ValueError(prefix+': нужны все поля положения, имени и нагрузки.')
        if (not isinstance(source['id'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',source['id'])
                or source['id'] in ids):
            raise ValueError(prefix+': идентификатор должен быть уникальным, 1–64 латинских букв, цифр, _ или -.')
        ids.add(source['id'])
        name = source['name']
        if not isinstance(name,str) or not 1 <= len(name.strip()) <= 80 or any(ord(c)<32 or 127<=ord(c)<=159 for c in name):
            raise ValueError(prefix+': нужно название от 1 до 80 символов без управляющих знаков.')
        x=source['source_distance_m']
        if isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) or not 0 <= x <= p['length_m']-100:
            raise ValueError(prefix+': ниже источника должно оставаться не менее 100 м полного участка.')
        legacy = {k:p[k] for k in SHARED} | {k:source[k] for k in ('effluent_flow_m3_s','effluent_mg_l','load_mode','load_duration_hours','load_intervals')}
        checked=validate_parameters(legacy)
        sources.append(dict(id=source['id'],name=name.strip(),source_distance_m=float(x),
                            **{k:checked.get(k) for k in ('effluent_flow_m3_s','effluent_mg_l','load_mode','load_duration_hours','load_intervals')}))
    p['sources']=sources
    return p


def source_intervals(source: dict, duration: float) -> list[dict]:
    if source['load_mode']=='profile':return source['load_intervals']
    end=duration if source['load_mode']=='continuous' else source['load_duration_hours']
    return [dict(start_hours=0.,end_hours=end,effluent_mg_l=source['effluent_mg_l'])]


def build_grid(p: dict, *, spatial_refinement: float=1., buffer_factor: float=1.) -> dict:
    """Build exact source/display faces; no coordinate rounding or source snapping."""
    length,u,d=p['length_m'],p['velocity_m_s'],p['dispersion_m2_s']
    per_segment=math.ceil(max(1.,length/100*u/(.5*d))*spatial_refinement)
    maximum_dx=length/(100*per_segment)
    buffer_cells=math.ceil(max(.1*length,20*d/u)*buffer_factor/maximum_dx)
    if 100*per_segment+buffer_cells > MAX_CELLS:
        raise ValueError('Слишком большой размер вычислений: более 6000 ячеек; сократите участок или уточнение.')
    # q=0 records remain in snapshots/markers, but add neither a hydraulic jump nor a grid face.
    physical=sorted((s for s in p['sources'] if s['effluent_flow_m3_s']>0),key=lambda s:(s['source_distance_m'],s['id']))
    positions=sorted({s['source_distance_m'] for s in physical if s['source_distance_m']>0})
    edges=[0.]; segment_cells=[]
    for j in range(100):
        a,b=j*length/100,(j+1)*length/100
        cuts=[a,*[x for x in positions if a<x<b],b]
        first=len(edges)-1
        for left,right in zip(cuts,cuts[1:]):
            count=math.ceil((right-left)/maximum_dx-1e-12)
            count=max(1,count)
            edges.extend([left+(right-left)*k/count for k in range(1,count)]+[right])
        segment_cells.append((first,len(edges)-1))
    shown_cells=len(edges)-1
    edges.extend(length+i*maximum_dx for i in range(1,buffer_cells+1))
    widths=[b-a for a,b in zip(edges,edges[1:])]
    if min(widths) <= 16*math.ulp(length):
        raise ValueError('Границы источников и сегментов слишком близки для машинной точности; измените положение источника.')
    if len(widths)>MAX_CELLS or any(w<=0 or not math.isfinite(w) for w in widths):
        raise ValueError('Слишком большой размер вычислений или неразличимые границы сетки.')
    grouped={x:[s for s in physical if s['source_distance_m']==x] for x in sorted({s['source_distance_m'] for s in physical})}
    flow=p['river_flow_m3_s']; flows=[]
    for x in edges[:-1]:
        flow += math.fsum(s['effluent_flow_m3_s'] for s in grouped.get(x,[]))
        flows.append(flow)
    volumes=[q/u*w for q,w in zip(flows,widths)]
    n=len(widths); lower=[0.]*n; upper=[0.]*n; diagonal=[0.]*n
    face_sources={}
    for face in range(1,n):
        # Exact two-half-cell exponential flux with the point-water jump.
        ql,qr=flows[face-1],flows[face]
        pl=u*widths[face-1]/(2*d);pr=u*widths[face]/(2*d)
        al=ql/-math.expm1(-pl);bl=ql/math.expm1(pl)
        ar=qr/-math.expm1(-pr);br=qr/math.expm1(pr)
        denominator=bl+ar
        alpha,beta=al*ar/denominator,bl*br/denominator
        i,j=face-1,face
        diagonal[i]-=alpha/volumes[i];upper[i]+=beta/volumes[i]
        lower[j]+=alpha/volumes[j];diagonal[j]-=beta/volumes[j]
        if edges[face] in grouped:
            face_sources[edges[face]]=[(i,bl/denominator/volumes[i]),(j,ar/denominator/volumes[j])]
    diagonal[-1]-=flows[-1]/volumes[-1]
    if 0. in grouped:face_sources[0.]=[(0,1/volumes[0])]
    return dict(edges=edges,widths=widths,volumes=volumes,flows=flows,lower=lower,upper=upper,diagonal=diagonal,
                face_sources=face_sources,grouped=grouped,segment_cells=segment_cells,shown_cells=shown_cells,
                buffer_m=buffer_cells*maximum_dx,maximum_dx_m=maximum_dx)


def simulate_multiple(params:dict,*,spatial_refinement:float=1.,temporal_refinement:float=1.,buffer_factor:float=1.,
                      reference_callback:Callable[[float,list[float]],None]|None=None) -> dict:
    started=time.perf_counter();p=validate_sources(params)
    for factor in (spatial_refinement,temporal_refinement,buffer_factor):
        if isinstance(factor,bool) or not isinstance(factor,(int,float)) or not math.isfinite(factor) or not 1<=factor<=8:
            raise ValueError('Коэффициент уточнения должен быть от 1 до 8.')
    grid=build_grid(p,spatial_refinement=spatial_refinement,buffer_factor=buffer_factor)
    cb=p['background_mg_l']*.001;seconds=p['duration_hours']*3600;n=len(grid['volumes'])
    diagonal,lower,upper=grid['diagonal'],grid['lower'],grid['upper']
    dt_limit=.8*2/max(-v for v in diagonal)/temporal_refinement
    steps_per_frame=math.ceil(seconds/48/dt_limit);nominal_steps=48*steps_per_frame
    def work_guard(steps):
        if n>MAX_CELLS or steps>MAX_STEPS or n*steps>MAX_UPDATES:
            raise ValueError('Слишком большой размер вычислений: сократите длительность или измените положение близких источников/параметры потока. '
                             f'Сетка: {n} ячеек, шагов: {steps}, операций ячейка-шаг: {n*steps}.')
    work_guard(nominal_steps)
    dt=seconds/nominal_steps
    events={0.:0.,seconds:p['duration_hours']}; intervals={};flat=[]
    for s in sorted(p['sources'],key=lambda s:s['id']):
        if s['effluent_flow_m3_s']==0:continue
        rows=source_intervals(s,p['duration_hours']);series=[]
        for r in rows:
            a,b=r['start_hours']*3600,r['end_hours']*3600
            for h,t in ((r['start_hours'],a),(r['end_hours'],b)):
                if t in events and events[t]!=h:raise _resolution_limit('близкие события нельзя различить с машинной точностью.')
                events[t]=h
            flux=s['effluent_flow_m3_s']*(r['effluent_mg_l']*.001-cb)
            series.append((a,b,flux));flat.append((a,b,flux))
        intervals[s['id']]=series
    schedule=_profile_steps(dt,nominal_steps,flat)
    work_guard(len(schedule));reference_bytes=(len(schedule)+1)*101*8
    if reference_bytes>MAX_REFERENCE_BYTES:raise _resolution_limit('опорная траектория превышает 16 MiB.')
    trajectory=array('d',[0.])*((len(schedule)+1)*101)
    endpoint_indices={end:i+1 for i,(_,end,_) in enumerate(schedule)}
    legacy_frames={0:0}|{endpoint_indices[i*steps_per_frame*dt]:i for i in range(1,49)}
    event_indices={endpoint_indices[t]:h for t,h in events.items() if 0<t<seconds}
    neighbors={}
    for index,h in event_indices.items():
        for neighbor,direction in ((index-1,-math.inf),(index+1,math.inf)):
            if neighbor not in event_indices:neighbors[neighbor]=(h,direction)
    mandatory=set(legacy_frames)|set(event_indices);directions=[0]*100;previous=None
    minima=[math.inf]*100;maxima=[-math.inf]*100;min_indices=[0]*100;max_indices=[0]*100
    segment_volumes=[math.fsum(grid['volumes'][a:b]) for a,b in grid['segment_cells']]
    def capture(index,t,state):
        nonlocal previous
        hour=t/3600
        if index in legacy_frames:
            frame=legacy_frames[index];hour=frame*p['duration_hours']/48
            if frame==0:hour=0.
            if frame==48:hour=p['duration_hours']
        if t in events:hour=events[t]
        values=[(cb+math.fsum(state[k]*grid['volumes'][k] for k in range(a,b))/volume)*1000
                for (a,b),volume in zip(grid['segment_cells'],segment_volumes)]
        if index in neighbors:
            event,direction=neighbors[index]
            if direction<0 or values!=previous:hour=_event_neighbor_hour(hour,event,direction,p['duration_hours'])
        if index in legacy_frames and legacy_frames[index] in (0,48):
            endpoint=0. if legacy_frames[index]==0 else p['duration_hours']
            if hour!=endpoint:raise _resolution_limit('близкие моменты нельзя различить с машинной точностью.')
        if previous is not None:
            for j,v in enumerate(values):
                difference=v-previous[j];direction=(difference>0)-(difference<0)
                if direction and directions[j] and direction!=directions[j]:mandatory.add(index-1)
                if direction:directions[j]=direction
        offset=index*101;trajectory[offset]=hour
        for j,v in enumerate(values):
            trajectory[offset+j+1]=v
            if v<minima[j]:minima[j],min_indices[j]=v,index
            if v>maxima[j]:maxima[j],max_indices[j]=v,index
        previous=values
        if reference_callback:reference_callback(hour,values)
    current=[0.]*n;work=[0.]*n;capture(0,0.,current)
    cache={};outgoing=0.;max_dt=0.
    def factors(step):
        h=step/2;inverse=[0.]*n;ratios=[0.]*n
        inverse[0]=1/(1-h*diagonal[0]);ratios[0]=-h*upper[0]*inverse[0]
        for i in range(1,n):
            inverse[i]=1/(1-h*diagonal[i]+h*lower[i]*ratios[i-1])
            ratios[i]=-h*upper[i]*inverse[i]
        return h,inverse,ratios
    time_left=0.
    for index,(step,end,_) in enumerate(schedule,1):
        fact=cache.get(step)
        if fact is None:
            fact=factors(step)
            if len(cache)<4:cache[step]=fact
        h,inverse,ratios=fact;forcing={}
        for x,group in grid['grouped'].items():
            flux=math.fsum(next((v for a,b,v in intervals[s['id']] if a<=time_left<b),0.) for s in group)
            for cell,weight in grid['face_sources'][x]:forcing[cell]=forcing.get(cell,0.)+flux*weight
        for i in range(n):
            rhs=(1+h*diagonal[i])*current[i]+step*forcing.get(i,0.)
            if i:rhs+=h*lower[i]*(current[i-1]+work[i-1])
            if i+1<n:rhs+=h*upper[i]*current[i+1]
            work[i]=rhs*inverse[i]
        old_last=current[-1];current[-1]=work[-1]
        for i in range(n-2,-1,-1):current[i]=work[i]-ratios[i]*current[i+1]
        outgoing+=step*grid['flows'][-1]*(old_last+current[-1])/2
        max_dt=max(max_dt,step);capture(index,end,current);time_left=end
    mandatory.update(min_indices);mandatory.update(max_indices)
    amplitudes=[max(abs(v-p['background_mg_l']),abs(w-p['background_mg_l'])) for v,w in zip(minima,maxima)]
    selected,error,checks=_compress_trajectory(trajectory,mandatory,amplitudes)
    distinct=[]
    for i in selected:
        if distinct and trajectory[i*101]<=trajectory[distinct[-1]*101]:
            old=distinct[-1]
            if trajectory[i*101:(i+1)*101]==trajectory[old*101:(old+1)*101]:continue
            raise _resolution_limit('близкие моменты нельзя различить с машинной точностью.')
        distinct.append(i)
    times=[trajectory[i*101] for i in distinct];rows=[list(trajectory[i*101+1:(i+1)*101]) for i in distinct]
    source_masses={s['id']:math.fsum((b-a)*f for a,b,f in intervals.get(s['id'],[])) for s in p['sources']}
    excess_in=math.fsum(source_masses.values());absolute_in=math.fsum(abs(f)*(b-a) for series in intervals.values() for a,b,f in series)
    stored=math.fsum(v*c for v,c in zip(grid['volumes'],current));excess_error=stored-(excess_in-outgoing)
    initial=cb*math.fsum(grid['volumes']);total_flow=grid['flows'][-1]
    full_in=total_flow*cb*seconds+excess_in;full_out=total_flow*cb*seconds+outgoing;mass_error=stored-(full_in-full_out)
    return dict(format_version=MULTIPLE_FORMAT_VERSION,model_id=MULTIPLE_MODEL_ID,inputs=p,
        derived=dict(total_flow_m3_s=total_flow,area_m2=total_flow/p['velocity_m_s'],load_kg_s=None,excess_load_kg_s=None,steady_mg_l=None,travel_hours=p['length_m']/p['velocity_m_s']/3600),
        distances_m=[(i+.5)*p['length_m']/100 for i in range(100)],times_hours=times,concentrations_mg_l=rows,
        scale_mg_l=[min([p['background_mg_l']]+minima),max([p['background_mg_l']]+maxima)],
        temporal_resolution=dict(method='adaptive-step-states',saved_states=len(times),reference_states=len(schedule)+1,max_states=MAX_OUTPUT_STATES,
            interpolation_relative_tolerance=INTERPOLATION_RELATIVE_TOLERANCE,interpolation_absolute_tolerance_mg_l=INTERPOLATION_ABSOLUTE_TOLERANCE_MG_L,
            max_relative_interpolation_error=error,reference_max_step_seconds=max_dt,max_gap_seconds=max(b-a for a,b in zip(times,times[1:]))*3600,
            memory_limit_bytes=MAX_REFERENCE_BYTES,reference_memory_bytes=reference_bytes,max_response_bytes=MAX_RESPONSE_BYTES,compression_checks=checks),
        diagnostics=dict(method='point-face exponential-fitted finite volume / Crank-Nicolson',cells=n,steps=len(schedule),cell_updates=n*len(schedule),
            dx_m=max(grid['widths']),min_dx_m=min(grid['widths']),dt_s=max_dt,cell_peclet=p['velocity_m_s']*max(grid['widths'])/p['dispersion_m2_s'],buffer_m=grid['buffer_m'],
            source_positions_m=[s['source_distance_m'] for s in p['sources']],source_position_error_m=[0.]*len(p['sources']),source_excess_mass_kg=source_masses,
            water_flow_segments_m3_s=[v/(p['length_m']/100)*p['velocity_m_s'] for v in segment_volumes],downstream_flow_m3_s=total_flow,
            initial_mass_kg=initial,final_mass_kg=initial+stored,incoming_mass_kg=full_in,outgoing_mass_kg=full_out,
            excess_stored_kg=stored,excess_incoming_kg=excess_in,excess_outgoing_kg=outgoing,mass_error_kg=mass_error,excess_mass_error_kg=excess_error,
            relative_mass_error=abs(mass_error)/max(abs(full_in),initial,1e-30),relative_excess_mass_error=abs(excess_error)/max(absolute_in,1e-30),
            runtime_seconds=time.perf_counter()-started))
