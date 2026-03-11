/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  Settings, 
  Navigation, 
  Moon, 
  CloudRain, 
  TrafficCone, 
  Weight, 
  Calculator, 
  ChevronRight, 
  X, 
  Save,
  Zap,
  History,
  Check,
  MapPin,
  Search,
  Loader2,
  Building2,
  Map as MapIcon,
  Info
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix Leaflet icon issue
// @ts-ignore
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// --- Types ---

interface Location {
  label: string;
  lat: number;
  lon: number;
}

interface AppSettings {
  fixedOrigin: Location;
  pricePerKm: number;
  extraWeightFee: number;
  badRoadFee: number;
  nightShiftFee: number;
  trafficFee: number;
  currency: string;
}

interface CalculationResult {
  distance: number;
  basePrice: number;
  additionalFees: number;
  totalPrice: number;
  timestamp: number;
  origin: string;
  destination: string;
  activeFees: string[];
}

// --- Constants ---

const DEFAULT_SETTINGS: AppSettings = {
  fixedOrigin: { 
    label: 'Atacadão, Estrada Professor Leandro Faria Sarzedas, Village Rio das Ostras, Rio das Ostras, RJ, 28895-638, Brasil', 
    lat: -22.5121, 
    lon: -41.9285 
  },
  pricePerKm: 11.00,
  extraWeightFee: 5.00,
  badRoadFee: 5.00,
  nightShiftFee: 5.00,
  trafficFee: 5.00,
  currency: 'R$',
};

// --- Utils ---

/**
 * Fetches real driving distance between two points using OSRM API.
 */
async function fetchDrivingDistance(lat1: number, lon1: number, lat2: number, lon2: number): Promise<number> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=false`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
      // OSRM returns distance in meters
      return data.routes[0].distance / 1000;
    }
    
    // Fallback to Haversine if OSRM fails
    return calculateHaversineDistance(lat1, lon1, lat2, lon2) * 1.4; // Add 40% as estimate for urban routes
  } catch (error) {
    console.error('Routing error:', error);
    return calculateHaversineDistance(lat1, lon1, lat2, lon2) * 1.4;
  }
}

/**
 * Calculates the distance between two points in KM using the Haversine formula (as fallback).
 */
function calculateHaversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// --- Components ---

export default function App() {
  // Global Settings & History
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [history, setHistory] = useState<CalculationResult[]>([]);
  const [isCalculating, setIsCalculating] = useState(false);
  const [activeFees, setActiveFees] = useState<Set<string>>(new Set());

  // Destination Search State
  const [destination, setDestination] = useState<Location | null>(null);
  const [destQuery, setDestQuery] = useState('');
  const [destSuggestions, setDestSuggestions] = useState<Location[]>([]);
  const [isSearchingDest, setIsSearchingDest] = useState(false);

  // Route State
  const [realDistance, setRealDistance] = useState<number>(0);
  const [isCalculatingRoute, setIsCalculatingRoute] = useState(false);

  // Origin Search State (for Settings)
  const [tempOrigin, setTempOrigin] = useState<Location>(DEFAULT_SETTINGS.fixedOrigin);
  const [originQuery, setOriginQuery] = useState('');
  const [originSuggestions, setOriginSuggestions] = useState<Location[]>([]);
  const [isSearchingOrigin, setIsSearchingOrigin] = useState(false);

  // Load settings and history
  useEffect(() => {
    const savedSettings = localStorage.getItem('geocalc_settings_v6');
    if (savedSettings) {
      const parsed = JSON.parse(savedSettings);
      setSettings(parsed);
      setTempOrigin(parsed.fixedOrigin);
      setOriginQuery(parsed.fixedOrigin.label);
    } else {
      // First time or version change: use defaults
      setTempOrigin(DEFAULT_SETTINGS.fixedOrigin);
      setOriginQuery(DEFAULT_SETTINGS.fixedOrigin.label);
    }

    const savedHistory = localStorage.getItem('geocalc_history_v6');
    if (savedHistory) setHistory(JSON.parse(savedHistory));
  }, []);

  // Sync origin search state when settings modal opens
  useEffect(() => {
    if (showSettings) {
      setTempOrigin(settings.fixedOrigin);
      setOriginQuery(settings.fixedOrigin.label);
    }
  }, [showSettings, settings.fixedOrigin]);

  // Generic Search Function
  const fetchLocations = async (query: string) => {
    if (query.length < 3) return [];
    try {
      // Bounding box for Rio das Ostras, Macaé, Cabo Frio, São Pedro da Aldeia
      // West: -42.2, North: -22.2, East: -41.6, South: -23.0
      const viewbox = '-42.2,-22.2,-41.6,-23.0'; 
      
      // We add "RJ" to help focus on the state
      let enhancedQuery = query;
      if (!query.toLowerCase().includes('rj') && !query.toLowerCase().includes('rio de janeiro')) {
        enhancedQuery += ', RJ';
      }

      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(enhancedQuery)}&limit=12&addressdetails=1&countrycodes=br&viewbox=${viewbox}&bounded=0`;
      
      const response = await fetch(url);
      const data = await response.json();
      
      return data.map((item: any) => {
        const addr = item.address;
        // Construct a more readable label: "Name/Street, Neighborhood - City, State"
        const name = item.name || addr.road || addr.pedestrian || addr.suburb || addr.city_district;
        const neighborhood = addr.suburb || addr.neighbourhood || addr.city_district || addr.village;
        const city = addr.city || addr.town || addr.municipality;
        const state = addr.state || 'RJ';
        
        let mainLabel = name;
        if (neighborhood && neighborhood !== name) mainLabel += `, ${neighborhood}`;
        
        let subLabel = '';
        if (city) subLabel += city;
        if (state) subLabel += subLabel ? `, ${state}` : state;

        return {
          label: item.display_name,
          displayLabel: mainLabel,
          secondaryLabel: subLabel,
          lat: parseFloat(item.lat),
          lon: parseFloat(item.lon)
        };
      });
    } catch (error) {
      console.error('Search error:', error);
      return [];
    }
  };

  // Debounced Destination Search
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (destQuery && (!destination || destQuery !== destination.label)) {
        setIsSearchingDest(true);
        const results = await fetchLocations(destQuery);
        setDestSuggestions(results);
        setIsSearchingDest(false);
      } else {
        setDestSuggestions([]);
        if (!destQuery) {
          setDestination(null);
          setRealDistance(0);
        }
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [destQuery, destination]);

  // Real Driving Distance Effect
  useEffect(() => {
    const updateRoute = async () => {
      if (destination) {
        setIsCalculatingRoute(true);
        const dist = await fetchDrivingDistance(
          settings.fixedOrigin.lat,
          settings.fixedOrigin.lon,
          destination.lat,
          destination.lon
        );
        setRealDistance(parseFloat(dist.toFixed(2)));
        setIsCalculatingRoute(false);
      }
    };
    updateRoute();
  }, [destination, settings.fixedOrigin]);

  // Debounced Origin Search (Settings)
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (originQuery && originQuery !== tempOrigin.label) {
        setIsSearchingOrigin(true);
        const results = await fetchLocations(originQuery);
        setOriginSuggestions(results);
        setIsSearchingOrigin(false);
      } else {
        setOriginSuggestions([]);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [originQuery, tempOrigin]);

  // Save settings
  const saveSettings = () => {
    const newSettings = { ...settings, fixedOrigin: tempOrigin };
    setSettings(newSettings);
    localStorage.setItem('geocalc_settings_v6', JSON.stringify(newSettings));
    setShowSettings(false);
  };

  // Toggle Fee
  const toggleFee = (fee: string) => {
    const next = new Set(activeFees);
    if (next.has(fee)) next.delete(fee);
    else next.add(fee);
    setActiveFees(next);
  };

  // Calculation Logic
  const currentResult = useMemo(() => {
    if (!destination || realDistance === 0) return { distance: 0, basePrice: 0, additionalFees: 0, totalPrice: 0 };

    const basePrice = realDistance * settings.pricePerKm;
    
    let additionalFees = 0;
    if (activeFees.has('weight')) additionalFees += settings.extraWeightFee;
    if (activeFees.has('road')) additionalFees += settings.badRoadFee;
    if (activeFees.has('night')) additionalFees += settings.nightShiftFee;
    if (activeFees.has('traffic')) additionalFees += settings.trafficFee;

    return {
      distance: realDistance,
      basePrice,
      additionalFees,
      totalPrice: basePrice + additionalFees
    };
  }, [destination, realDistance, settings, activeFees]);

  const handleCalculate = () => {
    if (!destination || realDistance === 0) return;
    
    setIsCalculating(true);
    setTimeout(() => {
      const result: CalculationResult = {
        ...currentResult,
        origin: settings.fixedOrigin.label,
        destination: destination.label,
        timestamp: Date.now(),
        activeFees: Array.from(activeFees)
      };
      
      const newHistory = [result, ...history].slice(0, 10);
      setHistory(newHistory);
      localStorage.setItem('geocalc_history_v6', JSON.stringify(newHistory));
      setIsCalculating(false);
      
      // Reset search
      setDestQuery('');
      setDestination(null);
      setRealDistance(0);
      setActiveFees(new Set());
    }, 800);
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white font-sans selection:bg-emerald-500/30 flex justify-center">
      {/* Mobile Container Constraint */}
      <div className="w-full max-w-[450px] min-h-screen bg-[#050505] relative flex flex-col shadow-2xl shadow-emerald-500/5 border-x border-white/5">
        
        {/* Background Atmosphere */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-0">
          <div className="absolute top-[-10%] left-[-10%] w-[60%] h-[40%] bg-emerald-500/10 blur-[120px] rounded-full" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[60%] h-[40%] bg-blue-500/10 blur-[120px] rounded-full" />
        </div>

        {/* Header */}
        <header className="relative z-10 px-6 pt-8 pb-4 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold tracking-tighter flex items-center gap-2">
              <Zap className="text-emerald-400 fill-emerald-400/20" size={24} />
              GEOCALC <span className="text-emerald-400">PRO</span>
            </h1>
            <p className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-medium">Logistics Engine v4.0</p>
          </div>
          <button 
            onClick={() => setShowSettings(true)}
            className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center hover:bg-white/10 transition-all active:scale-95"
          >
            <Settings size={20} className="text-white/70" />
          </button>
        </header>

        <main className="relative z-10 px-6 pb-24 space-y-8 flex-1">
          {/* Fixed Origin Info */}
          <section className="space-y-2">
            <label className="text-[10px] uppercase tracking-widest text-white/40 ml-1">Ponto de Partida (Fixo)</label>
            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-4 flex items-center gap-3">
              <MapPin size={18} className="text-emerald-400 shrink-0" />
              <span className="text-xs font-medium text-emerald-100 line-clamp-1">{settings.fixedOrigin.label}</span>
            </div>
          </section>

          {/* Destination Search Section */}
          <section className="space-y-4">
            <div className="space-y-2 relative">
              <label className="text-[10px] uppercase tracking-widest text-white/40 ml-1">Destino Final</label>
              <div className="bg-white/5 border border-white/10 rounded-2xl p-4 backdrop-blur-xl flex items-center gap-3 focus-within:border-emerald-500/50 transition-colors">
                <Search size={18} className="text-white/40" />
                <input 
                  type="text" 
                  placeholder="Rua, Bairro, Praça, Instituição..." 
                  value={destQuery}
                  onChange={(e) => setDestQuery(e.target.value)}
                  className="w-full bg-transparent border-none focus:ring-0 text-sm placeholder:text-white/20 p-0"
                />
                {(isSearchingDest || isCalculatingRoute) && <Loader2 size={16} className="animate-spin text-emerald-400" />}
              </div>

              {/* Suggestions Dropdown */}
              <AnimatePresence>
                {destSuggestions.length > 0 && (
                  <motion.div 
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="absolute top-full left-0 right-0 mt-2 bg-[#0A0A0A] border border-white/10 rounded-2xl overflow-hidden z-50 shadow-2xl max-h-60 overflow-y-auto"
                  >
                    {destSuggestions.map((loc: any, idx) => (
                      <button 
                        key={idx}
                        onClick={() => {
                          setDestination(loc);
                          setDestQuery(loc.displayLabel);
                          setDestSuggestions([]);
                        }}
                        className="w-full px-4 py-3 text-left hover:bg-white/5 border-b border-white/5 last:border-none flex items-start gap-3 transition-colors"
                      >
                        <Building2 size={14} className="mt-1 shrink-0 text-emerald-400/40" />
                        <div className="flex flex-col">
                          <span className="text-xs font-bold text-white/90 line-clamp-1">{loc.displayLabel}</span>
                          <span className="text-[10px] text-white/40 uppercase tracking-wider">{loc.secondaryLabel}</span>
                        </div>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {destination && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-4"
              >
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-[10px] uppercase tracking-widest text-white/40 ml-1">Distância de Rota</label>
                    <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-4 flex items-center gap-3">
                      <Navigation size={18} className={`text-emerald-400 ${isCalculatingRoute ? 'animate-pulse' : ''}`} />
                      <span className="text-xl font-bold">
                        {isCalculatingRoute ? '...' : realDistance} 
                        <span className="text-xs text-emerald-400/60 font-medium ml-1">KM</span>
                      </span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] uppercase tracking-widest text-white/40 ml-1">Preço/KM</label>
                    <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center gap-2">
                      <span className="text-emerald-400 font-bold">{settings.currency}</span>
                      <span className="text-xl font-bold">
                        {settings.pricePerKm.toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Map Preview */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center px-1">
                    <label className="text-[10px] uppercase tracking-widest text-white/40">Visualização do Percurso</label>
                    <div className="flex items-center gap-1 text-[10px] text-emerald-400/60 font-medium">
                      <Info size={10} />
                      <span>Confira os pontos no mapa</span>
                    </div>
                  </div>
                  <div className="h-48 rounded-3xl overflow-hidden border border-white/10 relative z-0">
                    <MapContainer 
                      center={[settings.fixedOrigin.lat, settings.fixedOrigin.lon]} 
                      zoom={13} 
                      style={{ height: '100%', width: '100%' }}
                      zoomControl={false}
                    >
                      <TileLayer
                        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                      />
                      <MapUpdater center={[destination.lat, destination.lon]} />
                      <Marker position={[settings.fixedOrigin.lat, settings.fixedOrigin.lon]}>
                        <Popup>Origem: Atacadão</Popup>
                      </Marker>
                      <Marker position={[destination.lat, destination.lon]}>
                        <Popup>Destino: {destination.label}</Popup>
                      </Marker>
                      <Polyline 
                        positions={[
                          [settings.fixedOrigin.lat, settings.fixedOrigin.lon],
                          [destination.lat, destination.lon]
                        ]} 
                        color="#10b981" 
                        weight={3}
                        dashArray="5, 10"
                      />
                    </MapContainer>
                  </div>
                </div>
              </motion.div>
            )}
          </section>

          {/* Additional Fees Section */}
          <section className="space-y-4">
            <label className="text-[10px] uppercase tracking-widest text-white/40 ml-1">Adicionais de Percurso</label>
            <div className="grid grid-cols-1 gap-2">
              <FeeCheckbox 
                icon={<Weight size={18} />} 
                label="Peso Extra" 
                active={activeFees.has('weight')} 
                onClick={() => toggleFee('weight')}
                value={settings.extraWeightFee}
                currency={settings.currency}
              />
              <FeeCheckbox 
                icon={<CloudRain size={18} />} 
                label="Estrada em Má Condição" 
                active={activeFees.has('road')} 
                onClick={() => toggleFee('road')}
                value={settings.badRoadFee}
                currency={settings.currency}
              />
              <FeeCheckbox 
                icon={<Moon size={18} />} 
                label="Período Noturno" 
                active={activeFees.has('night')} 
                onClick={() => toggleFee('night')}
                value={settings.nightShiftFee}
                currency={settings.currency}
              />
              <FeeCheckbox 
                icon={<TrafficCone size={18} />} 
                label="Trânsito Intenso" 
                active={activeFees.has('traffic')} 
                onClick={() => toggleFee('traffic')}
                value={settings.trafficFee}
                currency={settings.currency}
              />
            </div>
          </section>

          {/* Summary Card */}
          <section className="relative group">
            <div className="absolute inset-0 bg-emerald-500/20 blur-2xl rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            <div className="relative bg-gradient-to-br from-emerald-500/20 to-blue-500/20 border border-white/10 rounded-3xl p-6 backdrop-blur-2xl overflow-hidden">
              <div className="flex justify-between items-start mb-6">
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-white/60 mb-1">Total Calculado</p>
                  <h2 className="text-4xl font-black tracking-tighter">
                    <span className="text-emerald-400 text-2xl mr-1">{settings.currency}</span>
                    {currentResult.totalPrice.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </h2>
                </div>
                <div className="bg-white/10 p-3 rounded-2xl">
                  <Calculator size={24} className="text-emerald-400" />
                </div>
              </div>

              <button 
                onClick={handleCalculate}
                disabled={!destination || isCalculating}
                className={`w-full py-4 rounded-2xl font-bold uppercase tracking-widest text-sm flex items-center justify-center gap-2 transition-all active:scale-95 ${
                  !destination || isCalculating 
                    ? 'bg-white/5 text-white/20 cursor-not-allowed' 
                    : 'bg-emerald-500 text-black hover:bg-emerald-400 shadow-[0_8px_24px_rgba(16,185,129,0.3)]'
                }`}
              >
                {isCalculating ? (
                  <motion.div 
                    animate={{ rotate: 360 }} 
                    transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                  >
                    <Zap size={20} />
                  </motion.div>
                ) : (
                  <>
                    Gerar Orçamento Real
                    <ChevronRight size={18} />
                  </>
                )}
              </button>
            </div>
          </section>

          {/* History Section */}
          {history.length > 0 && (
            <section className="space-y-4">
              <div className="flex justify-between items-center px-1">
                <label className="text-[10px] uppercase tracking-widest text-white/40">Últimas Pesquisas</label>
                <History size={14} className="text-white/20" />
              </div>
              <div className="space-y-3">
                {history.map((item) => (
                  <div key={item.timestamp} className="bg-white/5 border border-white/5 rounded-2xl p-4 flex justify-between items-center group hover:bg-white/10 transition-colors">
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-white/80 line-clamp-1">→ {item.destination}</p>
                      <p className="text-[10px] text-white/40 uppercase tracking-wider">
                        {item.distance} KM • {new Date(item.timestamp).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-emerald-400">
                        {settings.currency} {item.totalPrice.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </main>

        {/* Settings Modal */}
        <AnimatePresence>
          {showSettings && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-end justify-center"
            >
              <motion.div 
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                className="bg-[#0A0A0A] border border-white/10 w-full max-w-[450px] rounded-t-[40px] p-8 space-y-8 overflow-y-auto max-h-[90vh]"
              >
                <div className="flex justify-between items-center">
                  <h2 className="text-xl font-bold tracking-tight">Configuração Geral</h2>
                  <button onClick={() => setShowSettings(false)} className="p-2 bg-white/5 rounded-full hover:bg-white/10">
                    <X size={20} />
                  </button>
                </div>

                <div className="space-y-6">
                  {/* Origin Search in Settings */}
                  <div className="space-y-2 relative">
                    <label className="text-[10px] uppercase tracking-widest text-white/40 ml-1">Origem Base (Fixo)</label>
                    <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center gap-3 focus-within:border-emerald-500/50 transition-colors">
                      <MapPin size={18} className="text-emerald-400 shrink-0" />
                      <input 
                        type="text" 
                        placeholder="Pesquisar origem (ex: Atacadão)..." 
                        value={originQuery}
                        onChange={(e) => setOriginQuery(e.target.value)}
                        className="bg-transparent border-none focus:ring-0 text-sm font-medium w-full p-0"
                      />
                      {isSearchingOrigin && <Loader2 size={16} className="animate-spin text-emerald-400" />}
                    </div>
                    
                    {/* Suggestions for Settings */}
                    <AnimatePresence>
                      {originSuggestions.length > 0 && (
                        <motion.div 
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className="absolute top-full left-0 right-0 mt-2 bg-[#111] border border-white/10 rounded-2xl overflow-hidden z-[60] shadow-2xl max-h-48 overflow-y-auto"
                        >
                          {originSuggestions.map((loc: any, idx) => (
                            <button 
                              key={idx}
                              onClick={() => {
                                setTempOrigin(loc);
                                setOriginQuery(loc.displayLabel);
                                setOriginSuggestions([]);
                              }}
                              className="w-full px-4 py-3 text-left hover:bg-white/5 border-b border-white/5 last:border-none flex items-start gap-3 transition-colors"
                            >
                              <Building2 size={14} className="mt-1 shrink-0 text-emerald-400/40" />
                              <div className="flex flex-col">
                                <span className="text-xs font-bold text-white/90 line-clamp-1">{loc.displayLabel}</span>
                                <span className="text-[10px] text-white/40 uppercase tracking-wider">{loc.secondaryLabel}</span>
                              </div>
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  <SettingsInput 
                    label="Valor por KM" 
                    value={settings.pricePerKm} 
                    onChange={(v) => setSettings({...settings, pricePerKm: v})} 
                    icon={<Navigation size={18} />}
                  />
                  
                  <div className="h-[1px] bg-white/5" />
                  
                  <div className="grid grid-cols-2 gap-4">
                    <SettingsInput 
                      label="Peso Extra" 
                      value={settings.extraWeightFee} 
                      onChange={(v) => setSettings({...settings, extraWeightFee: v})} 
                      icon={<Weight size={18} />}
                    />
                    <SettingsInput 
                      label="Estrada Ruim" 
                      value={settings.badRoadFee} 
                      onChange={(v) => setSettings({...settings, badRoadFee: v})} 
                      icon={<CloudRain size={18} />}
                    />
                    <SettingsInput 
                      label="Noturno" 
                      value={settings.nightShiftFee} 
                      onChange={(v) => setSettings({...settings, nightShiftFee: v})} 
                      icon={<Moon size={18} />}
                    />
                    <SettingsInput 
                      label="Trânsito" 
                      value={settings.trafficFee} 
                      onChange={(v) => setSettings({...settings, trafficFee: v})} 
                      icon={<TrafficCone size={18} />}
                    />
                  </div>
                </div>

                <button 
                  onClick={saveSettings}
                  className="w-full py-4 bg-white text-black rounded-2xl font-bold uppercase tracking-widest text-sm flex items-center justify-center gap-2 hover:bg-emerald-400 transition-colors"
                >
                  <Save size={18} />
                  Salvar Configurações
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Navigation Bar */}
        <nav className="sticky bottom-0 left-0 right-0 h-20 bg-black/40 backdrop-blur-2xl border-t border-white/5 z-40 flex items-center justify-around px-8">
          <button className="flex flex-col items-center gap-1 text-emerald-400">
            <Calculator size={24} />
            <span className="text-[10px] uppercase font-bold tracking-widest">Cálculo</span>
          </button>
          <button 
            onClick={() => setShowSettings(true)}
            className="flex flex-col items-center gap-1 text-white/40 hover:text-white transition-colors"
          >
            <Settings size={24} />
            <span className="text-[10px] uppercase font-bold tracking-widest">Ajustes</span>
          </button>
        </nav>
      </div>
    </div>
  );
}

// --- Subcomponents ---

function MapUpdater({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, 14);
  }, [center, map]);
  return null;
}

function FeeCheckbox({ icon, label, active, onClick, value, currency }: { 
  icon: React.ReactNode, 
  label: string, 
  active: boolean, 
  onClick: () => void,
  value: number,
  currency: string
}) {
  return (
    <button 
      onClick={onClick}
      className={`relative p-4 rounded-2xl border transition-all duration-300 flex items-center gap-4 text-left group ${
        active 
          ? 'bg-emerald-500/10 border-emerald-500/50' 
          : 'bg-white/5 border-white/10 hover:bg-white/10'
      }`}
    >
      <div className={`w-6 h-6 rounded-lg border flex items-center justify-center transition-all ${
        active 
          ? 'bg-emerald-500 border-emerald-500 text-black' 
          : 'bg-transparent border-white/20'
      }`}>
        {active && <Check size={14} strokeWidth={4} />}
      </div>
      
      <div className={`p-2 rounded-xl transition-colors ${active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/5 text-white/40'}`}>
        {icon}
      </div>

      <div className="flex-1">
        <p className={`text-xs font-bold tracking-tight ${active ? 'text-white' : 'text-white/60'}`}>
          {label}
        </p>
        <p className={`text-[10px] uppercase font-bold tracking-widest ${active ? 'text-emerald-400' : 'text-white/20'}`}>
          +{currency} {value.toFixed(2)}
        </p>
      </div>
    </button>
  );
}

function SettingsInput({ label, value, onChange, icon }: { 
  label: string, 
  value: number, 
  onChange: (v: number) => void,
  icon: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <label className="text-[10px] uppercase tracking-widest text-white/40 ml-1">{label}</label>
      <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center gap-3 focus-within:border-emerald-500/50 transition-colors">
        <div className="text-emerald-400">{icon}</div>
        <input 
          type="number" 
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="bg-transparent border-none focus:ring-0 text-lg font-bold w-full p-0"
        />
      </div>
    </div>
  );
}
