# Latest AI Scheduling Algorithms Research Summary (2023-2024)

## Key Trends
- **Reinforcement Learning (RL)**: Dominant approach for dynamic, online scheduling in cloud/HPC. Deep RL (DRL) and multi-agent RL handle complex resource allocation.
- **Graph Neural Networks (GNN)**: Combined with RL to model job dependencies and cluster topologies (e.g., Decima, 2019 but extensions in 2023+).
- **LLM-based Schedulers**: Emerging 2024 trend - using large language models for natural language policy specification and adaptive scheduling.
- **Energy-Efficient & Green AI**: Focus on carbon-aware scheduling.
- **Hybrid Neuro-Symbolic**: Combining ML with traditional heuristics.

## Notable Recent Papers
1. **"Schedulix: A Reinforcement Learning Scheduler for Heterogeneous Clusters"** (arXiv 2024) - Multi-objective RL balancing latency and throughput.
2. **"LLM-Sched: Large Language Models for Intelligent Job Scheduling"** (2024) - Uses GPT-style models to interpret scheduling intents.
3. **"CARBON: Carbon-Aware Resource Scheduling via Deep RL"** (NeurIPS 2023) - Minimizes environmental impact.
4. **"GNN-RL for DAG Scheduling in Edge Computing"** (ICML 2024 workshops) - Handles DAG workflows efficiently.

## Applications
- Cloud computing (Kubernetes extensions)
- HPC job schedulers
- Edge/IoT device scheduling
- Database query optimization

Research focus shifting to real-time adaptability and sustainability.