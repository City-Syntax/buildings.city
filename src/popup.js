      
import config from './config.json';

const aboutContent = `

    <h2>${config.city_name || 'City'} UBEM Description</h2>
    <p>${config.projectDescription || ''}</p>
    <br><br>
    
    <h2>About the Buildings.city Platform</h2>
    <p>
    Buildings.city is a lightweight toolkit developed through 
    <strong><a href="https://buildings.sg" target="_blank" class="link">Buildings.sg</a></strong> 
    to help cities quickly build interactive Urban Building Energy Modeling (UBEM) platforms using their own building data. 
    Through a simple configuration system and GeoJSON datasets, the package enables cities and researchers to visualize 
    urban buildings, explore energy-related information, and communicate city-scale building data through an interactive map interface.
    </p>

    <p>
    In addition to data visualization, the platform can support basic workflows for operational carbon and embodied carbon 
    analysis by connecting user-provided datasets or simulation results. Buildings.city was initially developed as part of 
    a research effort to lower the technical barrier for deploying urban energy platforms and can be adapted by cities and 
    research teams using their own data. For implementation guidance, please refer to the 
    <strong><a href="https://city-syntax.github.io/buildings.sg/documentation.html" target="_blank" class="link">Documentation</a></strong> 
    or explore the <strong><a href="https://github.com/City-Syntax/buildings.city" target="_blank" class="link">Open-source 
    Package</a></strong>.
    </p>
    <br><br>

    <h2>Data Introduction</h2>
    <p><strong>Embodied Carbon Simulation: </strong>
    Embodied carbon encompasses emissions from materials and construction throughout a building's lifecycle. While comprehensive life cycle assessments (LCA) consider multiple factors, this project focuses specifically on emissions from raw material extraction, transportation, manufacturing, and construction (stages A1-A5, known as "cradle to practical completion").
    Due to limited data availability and inherent uncertainties, we developed a probabilistic calculation methods. Results are therefore presented as probability distributions rather than single values, accurately reflecting uncertainty levels and enabling effective risk assessment.
    </p>
    <p><strong>Operational Carbon Simulation: </strong>
    Operational carbon represents emissions from a building's day-to-day energy use, including cooling, lighting, equipment, and heating systems. 
    Our approach uses Urban Building Energy Modeling (UBEM), a city-scale physics-based methodology that simulates energy performance across the built environment. This research-based analytical framework enables evaluation of multiple scenarios to identify effective carbon reduction strategies and promote energy efficiency.
    </p>
    <br><br>

    <h2>Quick Start Simulation</h2>
    <a href="https://city-syntax.github.io/buildings.sg/documentation.html">
        <a href="https://city-syntax.github.io/buildings.sg/documentation.html" target="_blank">
        <div style="text-align: center;">
            <button
                style="
                    width: 180px;
                    padding: 8px 16px;
                    margin-top: 5px;
                    text-align: center;
                    color: #fff;
                    background-color: #333;
                    border: 0;
                    border-radius: 10px;
                    font-family: 'Roboto Mono', Tahoma, Geneva, Verdana, sans-serif;
                    font-size: 12px;
                    box-shadow: 0 5px 10px rgba(0,0,0,0.1);
                    cursor: pointer;
                "
            >
                View Documentation
            </button>
        </div>
    </a>
    <br><br>
    
    <h2>Powered By</h2>
    <p></p>
    <div style="text-align: center; margin-top: 10px;">
        <a href="https://www.citysyntax.io/">
            <img src="public/images/logo_nus_citysyntax.jpg" style="height: 40px; width: auto;">
        </a>
    </div>
    
    `;

const popup   = document.getElementById('popup');
const overlay = document.getElementById('overlay');
const closeBtn = document.getElementById('close-btn');
const popupText = document.getElementById('popup-text');

document.getElementById('about-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    popupText.innerHTML = aboutContent;
    popup.style.display = 'flex';
    overlay.style.display = 'block';
});

closeBtn?.addEventListener('click', () => {
    popup.style.display = 'none';
    overlay.style.display = 'none';
});

overlay?.addEventListener('click', () => {
    popup.style.display = 'none';
    overlay.style.display = 'none';
});

